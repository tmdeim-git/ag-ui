# A2A Middleware Examples

## Using Direct Agents (New Feature)

You can now pass agents directly to the A2A middleware without exposing them via HTTP URLs:

```typescript
import { A2AMiddlewareAgent } from "@ag-ui/a2a-middleware";
import { getLocalAgents } from "@ag-ui/mastra";
import { Agent as MastraAgent } from "@mastra/core/agent";

// Get your Mastra agents
const mastraAgents = getLocalAgents({
  mastra: yourMastraInstance
});

const hrAgent = mastraAgents['hr_agent'];
const financeAgent = mastraAgents['finance_agent'];

// Create middleware with direct agents
const middleware = new A2AMiddlewareAgent({
  agents: [hrAgent, financeAgent], // Direct agent instances
  orchestrationAgent: yourOrchestratorAgent,
  instructions: `
    You are an HR manager. You have access to HR and Finance agents.
    Use them to complete HR-related tasks.
  `
});
```

## Using URL-based Agents (Original)

```typescript
const middleware = new A2AMiddlewareAgent({
  agentUrls: [
    "http://localhost:9002/finance",
    "http://localhost:9003/it"
  ],
  orchestrationAgent: yourOrchestratorAgent,
  instructions: "..."
});
```

## Mixed Usage

You can also mix both approaches:

```typescript
const middleware = new A2AMiddlewareAgent({
  agentUrls: ["http://localhost:9002/finance"], // Remote agent
  agents: [localHRAgent], // Direct agent
  orchestrationAgent: yourOrchestratorAgent,
  instructions: "..."
});
```
