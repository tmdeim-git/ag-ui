import {
  AbstractAgent,
  AgentConfig,
  BaseEvent,
  EventType,
  Message,
  RunAgentInput,
  RunFinishedEvent,
  TextMessageEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent
} from "@ag-ui/client";

import { randomUUID } from "crypto";
import { appendFileSync, writeFileSync } from "fs";
import { Observable, Subscriber } from "rxjs";
import { createSystemPrompt, sendMessageToA2AAgentTool } from "./utils";

export interface A2AAgentConfig extends AgentConfig {
  agents: AbstractAgent[];
  instructions?: string;
  orchestrationAgent: AbstractAgent;
}

export class A2AMiddlewareAgent extends AbstractAgent {
  agents: AbstractAgent[];
  instructions?: string;
  orchestrationAgent: AbstractAgent;
  toolCallArgs: Map<string, string>;
  debugLogFile: string;

  constructor(config: A2AAgentConfig) {
    super(config);
    this.instructions = config.instructions;
    this.agents = config.agents;
    this.orchestrationAgent = config.orchestrationAgent;
    this.toolCallArgs = new Map();
    this.debugLogFile = './a2a-middleware-debug.log';

    // Initialize log file
    if (this.debug) {
      try {
        writeFileSync(this.debugLogFile, `=== A2A Middleware Debug Log Started at ${new Date().toISOString()} ===\n\n`);
        console.log(`🔍 A2A Middleware debug logging enabled. Check ${this.debugLogFile} for detailed logs.`);
      } catch (error) {
        console.error('Failed to initialize debug log file:', error);
      }
    }
  }

  private writeDebugLog(message: string, data?: any) {
    if (!this.debug) return;

    try {
      const timestamp = new Date().toISOString();
      let logEntry = `[${timestamp}] ${message}`;

      if (data !== undefined) {
        if (typeof data === 'object') {
          logEntry += `\n${JSON.stringify(data, null, 2)}`;
        } else {
          logEntry += ` ${String(data)}`;
        }
      }

      logEntry += '\n\n';
      appendFileSync(this.debugLogFile, logEntry);
    } catch (error) {
      console.error('Failed to write to debug log file:', error);
    }
  }

  finishTextMessages(
    observer: Subscriber<{
      type: EventType;
      timestamp?: number | undefined;
      rawEvent?: any;
    }>,
    pendingTextMessages: Set<string>,
  ): void {
    pendingTextMessages.forEach((messageId) => {
      observer.next({
        type: EventType.TEXT_MESSAGE_END,
        messageId: messageId,
      } as TextMessageEndEvent);
      pendingTextMessages.delete(messageId);
    });
  }

  wrapStream(
    stream: Observable<BaseEvent>,
    pendingA2ACalls: Set<string>,
    pendingTextMessages: Set<string>,
    observer: Subscriber<{
      type: EventType;
      timestamp?: number | undefined;
      rawEvent?: any;
    }>,
    input: RunAgentInput,
  ): any {
    return stream.subscribe({
        next: (event: BaseEvent) => {
          this.writeDebugLog("Middleware received event", { type: event.type, event });

          // Handle tool call args events to capture arguments
          if (event.type === "TOOL_CALL_ARGS" && "toolCallId" in event) {
            const toolCallArgsEvent = event as any;
            if (toolCallArgsEvent.args) {
              this.toolCallArgs.set(event.toolCallId as string, toolCallArgsEvent.args);
            } else if (toolCallArgsEvent.delta) {
              // Accumulate delta args
              const existing = this.toolCallArgs.get(event.toolCallId as string) || "";
              this.toolCallArgs.set(event.toolCallId as string, existing + toolCallArgsEvent.delta);
            }
            this.writeDebugLog("Stored tool call args", {
              toolCallId: event.toolCallId,
              args: this.toolCallArgs.get(event.toolCallId as string)
            });
            // Proxy the args event normally
            observer.next(event);
            return;
          }

          // Handle tool call start events for send_message_to_a2a_agent
          if (
            event.type === "TOOL_CALL_START" &&
            "toolCallName" in event &&
            "toolCallId" in event &&
            (event as ToolCallStartEvent).toolCallName.startsWith("send_message_to_a2a_agent")
          ) {
            // Track this as a pending A2A call
            pendingA2ACalls.add(event.toolCallId as string);
            // Proxy the start event normally
            observer.next(event);
            return;
          }

          // Handle tool call end events
          if (event.type === "TOOL_CALL_END" && "toolCallId" in event) {
            // Proxy the end event normally
            observer.next(event);
            return;
          }

          // Handle tool call result events for send_message_to_a2a_agent
          if (
            event.type === "TOOL_CALL_RESULT" &&
            "toolCallId" in event &&
            pendingA2ACalls.has(event.toolCallId as string)
          ) {
            // This is a result for our A2A tool call
            pendingA2ACalls.delete(event.toolCallId as string);
            observer.next(event);
            return;
          }

          // Handle run completion events
          if (event.type === "RUN_FINISHED") {
            this.finishTextMessages(observer, pendingTextMessages);

            if (pendingA2ACalls.size > 0) {
              // Array to collect all new tool result messages
              const newToolMessages: Message[] = [];

              const callProms = [...pendingA2ACalls].map((toolCallId) => {
                const toolArgs = this.toolCallArgs.get(toolCallId);
                if (this.debug) {
                  console.debug("Retrieving tool call args for", toolCallId, "found:", !!toolArgs);
                }
                if (!toolArgs) {
                  throw new Error(`Tool arguments not found for tool call id ${toolCallId}`);
                }
                const parsed = JSON.parse(toolArgs);
                const agentName = parsed.agentName;
                const task = parsed.task;

                if (this.debug) {
                  console.debug("sending message to a2a agent", { agentName, message: task });
                }
                return this.sendMessageToA2AAgent(agentName, task)
                  .then((a2aResponse) => {
                    const newMessage: Message = {
                      id: randomUUID(),
                      role: "tool",
                      toolCallId: toolCallId,
                      content: a2aResponse,
                    };
                    this.writeDebugLog("newMessage From a2a agent", newMessage);
                    this.addMessage(newMessage);
                    this.orchestrationAgent.addMessage(newMessage);

                    // Collect the message so we can add it to input.messages
                    newToolMessages.push(newMessage);

                    this.writeDebugLog(`[ORCHESTRATOR] Creating tool result for ${toolCallId}`, {
                      agentName,
                      responseLength: a2aResponse.length,
                      responsePreview: a2aResponse.substring(0, 200) + (a2aResponse.length > 200 ? '...' : ''),
                      messageId: newMessage.id
                    });

                    const newEvent = {
                      type: "TOOL_CALL_RESULT",
                      toolCallId: toolCallId,
                      messageId: newMessage.id,
                      content: a2aResponse,
                    } as ToolCallResultEvent;

                    this.writeDebugLog(`[ORCHESTRATOR] Sending tool result event`, newEvent);

                    observer.next(newEvent);

                    // Clean up stored tool call args
                    this.toolCallArgs.delete(toolCallId);
                    pendingA2ACalls.delete(toolCallId);
                  })
                  .finally(() => {
                    pendingA2ACalls.delete(toolCallId as string);
                  });
              });

              Promise.all(callProms).then(() => {
                observer.next({
                  type: "RUN_FINISHED",
                  threadId: input.threadId,
                  runId: input.runId,
                } as RunFinishedEvent);

                // Add all tool result messages to input.messages BEFORE triggering new run
                // This ensures the orchestrator sees the tool results in its context
                this.writeDebugLog(`[MIDDLEWARE] Adding ${newToolMessages.length} tool result messages to new run input`);
                newToolMessages.forEach((msg, i) => {
                  this.writeDebugLog(`[MIDDLEWARE] Tool message ${i + 1}`, {
                    role: msg.role,
                    toolCallId: (msg as any).toolCallId,
                    contentLength: msg.content?.length || 0,
                    contentPreview: msg.content?.substring(0, 100) + (msg.content && msg.content.length > 100 ? '...' : '')
                  });
                });

                newToolMessages.forEach((msg) => {
                  input.messages.push(msg);
                });

                this.writeDebugLog(`[MIDDLEWARE] Triggering new run`, { totalMessages: input.messages.length });

                this.triggerNewRun(observer, input, pendingA2ACalls, pendingTextMessages);
              });
            } else {
              observer.next(event);
              observer.complete();
              return;
            }
            return;
          }

          // Handle run error events - emit immediately and exit
          if (event.type === "RUN_ERROR") {
            this.writeDebugLog("[MIDDLEWARE] Run error", event);
            observer.next(event);
            observer.error(event);
            return;
          }

          // Proxy all other events
          observer.next(event);
        },
        error: (error) => {
          observer.error(error);
        },
        complete: () => {
          // Only complete if run is actually finished and no pending calls
          if (pendingA2ACalls.size === 0) {
            observer.complete();
          }
        },
      });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((observer) => {
      const run = async () => {
        let pendingA2ACalls = new Set<string>();
        const pendingTextMessages = new Set<string>();
        const newSystemPrompt = createSystemPrompt(this.agents, this.instructions);

        const messages = input.messages;
        if (messages.length && messages[0].role === "system") {
          // remove the first message if it is a system message
          messages.shift();
        }

        messages.unshift({
          role: "system",
          content: newSystemPrompt,
          id: randomUUID(),
        });

        input.tools = [...(input.tools || []), sendMessageToA2AAgentTool];

        // Start the orchestration agent run
        this.triggerNewRun(observer, input, pendingA2ACalls, pendingTextMessages);
      };
      run();
    });
  }

  private async sendMessageToA2AAgent(agentName: string, args: string): Promise<string> {
    this.writeDebugLog("Available agents", this.agents.map(a => ({
      agentId: (a as any).agentId,
      name: (a as any).agent?.name,
      id: (a as any).agent?.id
    })));
    this.writeDebugLog("Looking for agent", agentName);

    const agent = this.agents.find((agent) => (agent as any).agentId === agentName || (agent as any).agent?.name === agentName || (agent as any).agent?.id === agentName);

    if (!agent) {
      throw new Error(`Agent "${agentName}" not found`);
    }

    // Create a run input for the agent
    const runInput: RunAgentInput = {
      messages: [
        {
          id: randomUUID(),
          role: "user",
          content: args,
        }
      ],
      threadId: randomUUID(),
      runId: randomUUID(),
      tools: [],
      context: [],
    };

    return new Promise<string>((resolve, reject) => {
      const stream = agent.run(runInput);
      let responseContent = "";
      let hasError = false;
      let textMessageActive = false;

      stream.subscribe({
        next: (event: BaseEvent) => {
          this.writeDebugLog(`[${agentName}] received event`, { type: event.type, event });

          // Silently consume all events from the delegated agent
          // Only collect text content, don't forward events to avoid conflicts
          if (event.type === "TEXT_MESSAGE_START") {
            textMessageActive = true;
            this.writeDebugLog(`[${agentName}] Text message started`);
          } else if (event.type === "TEXT_MESSAGE_END") {
            textMessageActive = false;
            this.writeDebugLog(`[${agentName}] Text message ended`, { contentLength: responseContent.length });
          } else if (event.type === "RUN_ERROR") {
            hasError = true;
            this.writeDebugLog(`[${agentName}] Run error`, event);
            reject(new Error(`Agent "${agentName}" encountered an error`));
          } else if (event.type === "TEXT_MESSAGE_CONTENT" || event.type === "TEXT_MESSAGE_CHUNK") {
            // For TEXT_MESSAGE_CHUNK, automatically activate text collection if not already active
            if (event.type === "TEXT_MESSAGE_CHUNK" && !textMessageActive) {
              textMessageActive = true;
              this.writeDebugLog(`[${agentName}] Auto-activated text message for chunk`);
            }

            // Only accumulate if text message is active
            if (textMessageActive) {
              const textEvent = event as any;
              let delta = "";
              if (textEvent.delta) {
                delta = textEvent.delta;
                responseContent += textEvent.delta;
              } else if (textEvent.content) {
                delta = textEvent.content;
                responseContent += textEvent.content;
              }

              this.writeDebugLog(`[${agentName}] Added content from ${event.type}`, { delta, totalLength: responseContent.length });
            }
          }
          // Ignore all other events (tool calls, etc.) from the delegated agent
        },
        error: (error) => {
          this.writeDebugLog(`[${agentName}] Stream error`, error);
          hasError = true;
          reject(error);
        },
        complete: () => {
          // Auto-end text message if it was auto-started
          if (textMessageActive) {
            this.writeDebugLog(`[${agentName}] Auto-ending text message on stream completion`);
            textMessageActive = false;
          }

          this.writeDebugLog(`[${agentName}] Stream completed`, {
            finalResponse: responseContent,
            responseLength: responseContent.length
          });

          if (!hasError) {
            const finalResponse = responseContent || "Agent completed the task successfully.";
            this.writeDebugLog(`[${agentName}] Resolving with`, finalResponse);
            resolve(finalResponse);
          }
        }
      });
    });
  }

  private triggerNewRun(
    observer: any,
    input: RunAgentInput,
    pendingA2ACalls: Set<string>,
    pendingTextMessages: Set<string>,
  ): void {
    const newRunStream = this.orchestrationAgent.run(input);
    this.wrapStream(newRunStream, pendingA2ACalls, pendingTextMessages, observer, input);
  }
}
