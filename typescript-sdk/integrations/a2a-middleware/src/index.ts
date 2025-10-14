import {
  AbstractAgent,
  AgentConfig,
  BaseEvent,
  EventType,
  Message,
  RunAgentInput,
  RunFinishedEvent,
  TextMessageChunkEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
  transformChunks
} from "@ag-ui/client";

import { AgentCard, SendMessageResponse, SendMessageSuccessResponse } from "@a2a-js/sdk";
import { A2AClient } from "@a2a-js/sdk/client";
import { randomUUID } from "@ag-ui/client";
import { Observable, Subscriber, tap } from "rxjs";
import { createSystemPrompt, sendMessageToA2AAgentTool } from "./utils";


export interface A2AAgentConfig extends AgentConfig {
  agentUrls?: string[];  // Optional: for remote A2A agents
  agents?: AbstractAgent[];  // New: for direct agent instances
  instructions?: string;
  orchestrationAgent: AbstractAgent;
}

// Internal interface for unified agent handling
interface UnifiedAgent {
  name: string;
  description: string;
  client?: A2AClient;  // For URL-based agents
  agent?: AbstractAgent;  // For direct agents
}

export class A2AMiddlewareAgent extends AbstractAgent {
  agentClients: A2AClient[];
  directAgents: AbstractAgent[];  // New: store direct agents
  unifiedAgents: UnifiedAgent[];  // New: unified view of all agents
  agentCards: Promise<AgentCard[]>;
  instructions?: string;
  orchestrationAgent: AbstractAgent;
  toolCallArgs: Map<string, string>;  // Store tool call arguments by ID

  constructor(config: A2AAgentConfig) {
    super(config);
    this.instructions = config.instructions;
    this.orchestrationAgent = config.orchestrationAgent;
    this.toolCallArgs = new Map<string, string>();

    // Handle URL-based agents (existing logic)
    this.agentClients = (config.agentUrls || []).map((url) => new A2AClient(url));

    // Store direct agents (new)
    this.directAgents = config.agents || [];

    // Create unified agent list
    this.unifiedAgents = [
      // URL-based agents
      ...this.agentClients.map((client, index) => ({
        client,
        name: `url_agent_${index}`,
        description: `Remote A2A agent at ${(config.agentUrls || [])[index]}`
      })),
      // Direct agents
      ...this.directAgents.map((agent, index) => ({
        agent,
        name: agent.agentId || `direct_agent_${index}`,
        description: agent.description || `Direct agent ${index}`
      }))
    ];

    // Get agent cards only for URL-based agents
    this.agentCards = config.agentUrls && config.agentUrls.length > 0 ?
      Promise.all(this.agentClients.map((client) => client.getAgentCard())) :
      Promise.resolve([]);
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
    const applyAndProcessEvents = (source$: Observable<BaseEvent>) => {
      // Apply events to get mutations
      const mutations$ = this.apply(input, source$, this.subscribers);
      // Process the mutations
      const processedMutations$ = this.processApplyEvents(input, mutations$, this.subscribers);
      // Subscribe to the processed mutations to trigger side effects
      processedMutations$.subscribe();
      // Return the original stream to maintain BaseEvent type
      return source$;
    };

    const markTextMessageAsPending = (event: BaseEvent) => {
      if (event.type === EventType.TEXT_MESSAGE_START) {
        const textMessageStartEvent = event as TextMessageStartEvent;
        pendingTextMessages.add(textMessageStartEvent.messageId);
        if (this.debug) {
          console.debug("Added pending text message:", textMessageStartEvent.messageId);
        }
        return;
      }
      if (event.type === EventType.TEXT_MESSAGE_END) {
        const textMessageEndEvent = event as TextMessageEndEvent;
        pendingTextMessages.delete(textMessageEndEvent.messageId);
        if (this.debug) {
          console.debug("Removed pending text message:", textMessageEndEvent.messageId);
        }
        return;
      }
    };

    return stream
      .pipe(transformChunks(this.debug), applyAndProcessEvents, tap(markTextMessageAsPending))
      .subscribe({
        next: (event: BaseEvent) => {
          // Handle tool call args events to capture arguments
          if (event.type === EventType.TOOL_CALL_ARGS) {
            const argsEvent = event as ToolCallArgsEvent;
            // Accumulate tool call arguments (they might come in chunks)
            const existingArgs = this.toolCallArgs.get(argsEvent.toolCallId) || "";
            this.toolCallArgs.set(argsEvent.toolCallId, existingArgs + (argsEvent.delta || ""));
            if (this.debug) {
              console.debug("Captured tool call args:", argsEvent.toolCallId, "delta:", argsEvent.delta, "total:", existingArgs + (argsEvent.delta || ""));
            }
            // Proxy the args event normally
            observer.next(event);
            return;
          }

          // Handle tool call start events for send_message_to_a2a_agent
          if (
            event.type === EventType.TOOL_CALL_START &&
            "toolCallName" in event &&
            "toolCallId" in event &&
            (event as ToolCallStartEvent).toolCallName.startsWith("send_message_to_a2a_agent")
          ) {
            // Track this as a pending A2A call
            pendingA2ACalls.add(event.toolCallId as string);
            if (this.debug) {
              console.debug("Started tracking A2A tool call:", event.toolCallId);
            }
            // Proxy the start event normally
            observer.next(event);
            return;
          }

          // Handle tool call result events for send_message_to_a2a_agent
          if (
            event.type === EventType.TOOL_CALL_RESULT &&
            "toolCallId" in event &&
            pendingA2ACalls.has(event.toolCallId as string)
          ) {
            // This is a result for our A2A tool call
            pendingA2ACalls.delete(event.toolCallId as string);
            observer.next(event);
            return;
          }

          // Handle run completion events
          if (event.type === EventType.RUN_FINISHED) {
            this.finishTextMessages(observer, pendingTextMessages);

            if (pendingA2ACalls.size > 0) {
              // Array to collect all new tool result messages
              const newToolMessages: Message[] = [];

              const callProms = [...pendingA2ACalls].map((toolCallId) => {
                // Get tool call arguments from our stored map
                const toolArgs = this.toolCallArgs.get(toolCallId);

                if (this.debug) {
                  console.debug("Looking for tool call args:", toolCallId);
                  console.debug("Found args:", toolArgs);
                  console.debug("All stored args:", Array.from(this.toolCallArgs.entries()));
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
                    if (this.debug) {
                      console.debug("newMessage From a2a agent", newMessage);
                    }
                    this.addMessage(newMessage);
                    this.orchestrationAgent.addMessage(newMessage);

                    // Collect the message so we can add it to input.messages
                    newToolMessages.push(newMessage);

                    const newEvent: ToolCallResultEvent = {
                      type: EventType.TOOL_CALL_RESULT,
                      toolCallId: toolCallId,
                      messageId: newMessage.id,
                      content: a2aResponse,
                    };

                    observer.next(newEvent);

                    // Clean up the stored tool call arguments
                    this.toolCallArgs.delete(toolCallId);
                    pendingA2ACalls.delete(toolCallId);
                  })
                  .finally(() => {
                    // Clean up on error too
                    this.toolCallArgs.delete(toolCallId);
                    pendingA2ACalls.delete(toolCallId as string);
                  });
              });

              Promise.all(callProms).then(() => {
                this.finishTextMessages(observer, pendingTextMessages);
                observer.next({
                  type: EventType.RUN_FINISHED,
                  threadId: input.threadId,
                  runId: input.runId,
                } as RunFinishedEvent);

                // Add all tool result messages to input.messages BEFORE triggering new run
                // This ensures the orchestrator sees the tool results in its context
                newToolMessages.forEach((msg) => {
                  input.messages.push(msg);
                });

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
          if (event.type === EventType.RUN_ERROR) {
            observer.next(event);
            observer.error(event);
            return;
          }

          // Proxy all other events
          if (this.debug && event.type === EventType.TEXT_MESSAGE_CONTENT) {
            console.debug("Forwarding TEXT_MESSAGE_CONTENT event:", event);
            console.debug("Pending text messages:", Array.from(pendingTextMessages));
          }
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
        const agentCards = await this.agentCards;
        const newSystemPrompt = createSystemPrompt(agentCards, this.directAgents, this.instructions);

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
    // Find the agent in our unified list
    const unifiedAgent = this.unifiedAgents.find(agent => agent.name === agentName);

    if (!unifiedAgent) {
      throw new Error(`Agent "${agentName}" not found`);
    }

    if (unifiedAgent.client) {
      // Handle URL-based agent (existing logic)
      const { client } = unifiedAgent;
      const sendResponse: SendMessageResponse = await client.sendMessage({
        message: {
          kind: "message",
          messageId: Date.now().toString(),
          role: "agent",
          parts: [{ text: args, kind: "text" }],
        },
      });

      if ("error" in sendResponse) {
        throw new Error(
          `Error sending message to agent "${agentName}": ${sendResponse.error.message}`,
        );
      }

      const result = (sendResponse as SendMessageSuccessResponse).result;
      let responseContent = "";

      if (result.kind === "message" && result.parts.length > 0 && result.parts[0].kind === "text") {
        responseContent = result.parts[0].text;
      } else {
        responseContent = JSON.stringify(result);
      }

      return responseContent;
    } else if (unifiedAgent.agent) {
      // Handle direct agent (new logic) - run asynchronously and return promise
      const { agent } = unifiedAgent;

      // Create input for the direct agent
      const input: RunAgentInput = {
        threadId: `a2a-${Date.now()}`,
        runId: `run-${Date.now()}`,
        messages: [{
          id: `msg-${Date.now()}`,
          role: "user",
          content: args,
        }],
        tools: [],
        context: [],
        state: {},
      };

      // Run the direct agent asynchronously and collect its response
      return new Promise((resolve, reject) => {
        let collectedResponse = "";

        const subscription = agent.run(input).subscribe({
          next: (event) => {
            // Collect text from the direct agent's response
            if (event.type === EventType.TEXT_MESSAGE_CHUNK) {
              const textEvent = event as TextMessageChunkEvent;
              collectedResponse += textEvent.delta;
            } else if (event.type === EventType.TEXT_MESSAGE_START) {
              // Track message start for proper lifecycle
              collectedResponse = ""; // Reset for new message
            }
          },
          error: (error) => {
            console.error("Error running direct agent:", error);
            reject(error);
          },
          complete: () => {
            resolve(collectedResponse || "");
          }
        });
      });
    } else {
      throw new Error(`Agent "${agentName}" has no client or agent instance`);
    }
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
