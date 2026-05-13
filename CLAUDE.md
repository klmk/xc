# AI Dev Platform - Project Rules

> This document provides context and rules for AI assistants working on this codebase.

## Project Overview

AI Dev Platform is a multi-agent automated software development system. It uses specialized AI agents (Explorer, Architect, Builder, Verifier, Evolver) that collaborate via a message bus to develop software from natural language requirements.

**Key Principle**: "80% thinking/defining, 20% code generation" - The spec is the single source of truth.

## Architecture

### Core Components

```
src/
├── core/           # Infrastructure
│   ├── message-bus.ts    # Pub/sub + request/response messaging
│   ├── agent-base.ts     # Abstract base class for all agents
│   ├── task-executor.ts  # DAG-based parallel task execution
│   ├── state-manager.ts  # State persistence + snapshots
│   ├── hooks.ts          # 26 lifecycle hook events
│   └── logger.ts         # Structured logging
├── agents/         # AI Agents
│   ├── orchestrator.ts   # Central coordinator
│   ├── explorer.ts       # Research & web search
│   ├── architect.ts      # Executable specifications
│   ├── developer.ts      # Code generation
│   ├── verifier.ts       # Tool-driven testing
│   └── evolver.ts        # Change management
├── tools/          # Utilities
│   ├── llm-client.ts     # DeepSeek API wrapper
│   ├── file-system.ts    # File operations
│   ├── git-client.ts     # Git + worktree + checkpoints
│   └── sandbox.ts        # Isolated execution
├── tests/          # Testing
│   ├── static-verifier.ts   # TypeScript + ESLint
│   ├── runtime-verifier.ts  # Server + API tests
│   ├── business-verifier.ts # Playwright E2E
│   └── test-reporter.ts     # Report generation
└── prompts/        # System prompts
    └── system-prompts.ts    # Agent-specific prompts
```

### Message Flow

```
User Request → Orchestrator
                   ↓
           ┌───────┼───────┐
           ↓       ↓       ↓
       Explorer Architect Builder
           ↓       ↓       ↓
           └───────┼───────┘
                   ↓
              Verifier → Evolver
```

## Coding Standards

### TypeScript

- **Strict mode**: Always enabled
- **Indentation**: 2 spaces
- **Semicolons**: Required
- **Quotes**: Single quotes for strings
- **Imports**: Use `.js` extension for local imports (ESM)
- **Types**: Prefer explicit types over `any`

### Naming Conventions

```typescript
// Classes: PascalCase
class OrchestratorAgent {}

// Functions/Variables: camelCase
function executeTask() {}
const taskResult = {};

// Constants: SCREAMING_SNAKE_CASE
const MAX_RETRIES = 3;

// Interfaces: PascalCase with descriptive names
interface TaskDescriptor {}

// Private members: prefix with underscore in parameters
constructor(private _config: Config) {}
```

### File Organization

```typescript
// 1. Imports (Node built-ins first, then external, then local)
import { readFile } from 'node:fs/promises';
import type { SomeType } from 'external-package';
import { localModule } from './local-module.js';

// 2. Types and Interfaces
export interface MyInterface {}

// 3. Constants
const MY_CONSTANT = 'value';

// 4. Main class/function
export class MyClass {}

// 5. Helper functions (private)
function helper() {}
```

## Agent System

### Agent Lifecycle

```typescript
// Every agent follows this pattern:
class MyAgent extends AgentBase {
  constructor(config, messageBus, ...dependencies) {
    super(config, messageBus);
    // Initialize dependencies
  }

  async initialize(): Promise<void> {
    // Setup subscriptions, load state
  }

  async execute(task: TaskDescriptor): Promise<TaskResult> {
    // Main execution logic
  }

  async shutdown(): Promise<void> {
    // Cleanup resources
  }
}
```

### Message Types

```typescript
type MessageType =
  // Task lifecycle
  | 'task_assigned' | 'task_completed' | 'task_failed'
  // Sub-agent
  | 'subagent_created' | 'subagent_result' | 'subagent_cancel'
  // Parallel coordination
  | 'parallel_task_start' | 'parallel_task_complete'
  // Project lifecycle
  | 'project_initialized' | 'spec_generated' | 'verification_started'
  // Checkpoint
  | 'checkpoint_created' | 'rollback_executed';
```

### Hook Events (26 total)

```typescript
type HookType =
  // Session: sessionStart, sessionEnd, setup
  // Turn: userPromptSubmit, stop, stopFailure
  // Tool: preToolUse, postToolUse, postToolUseFailure
  // Sub-agent: subagentStart, subagentStop
  // Context: preCompact, postCompact
  // Task: taskCreated, taskCompleted
  // File: fileChanged, worktreeCreate, worktreeRemove
```

## Testing Strategy

### Three-Layer Verification

1. **Static Layer** (`static-verifier.ts`)
   - TypeScript compilation: `tsc --noEmit`
   - ESLint: `eslint . --ext .ts,.tsx`
   - Build: `npm run build`

2. **Runtime Layer** (`runtime-verifier.ts`)
   - Server startup check
   - Health endpoint verification
   - API endpoint testing

3. **Business Layer** (`business-verifier.ts`)
   - Playwright E2E tests
   - User flow scenarios
   - Screenshot capture on failure

### Running Tests

```bash
# TypeScript check
npx tsc --noEmit

# Run example project
cd examples/todo-app && npm install && npm run build

# Start web UI
cd web && npm install && npm run dev
```

## Development Workflow

### Before Making Changes

1. Run `npx tsc --noEmit` to verify no errors
2. Check relevant agent/system prompts
3. Review message bus subscriptions

### After Making Changes

1. Run TypeScript check
2. Test affected functionality
3. Update CLAUDE.md if architecture changes
4. Commit with conventional commit message

### Commit Message Format

```
type(scope): description

Types: feat, fix, refactor, test, docs, chore
Scopes: core, agents, tools, tests, web
```

## Key Files

| File | Purpose |
|------|---------|
| `src/core/message-bus.ts` | All inter-agent communication |
| `src/core/agent-base.ts` | Agent lifecycle + context compression |
| `src/core/hooks.ts` | 26 lifecycle hooks |
| `src/core/state-manager.ts` | State + snapshots |
| `src/tools/git-client.ts` | Worktree isolation + checkpoints |
| `src/agents/orchestrator.ts` | Central coordinator |
| `src/agents/verifier.ts` | Tool-driven testing |
| `src/prompts/system-prompts.ts` | Agent behavior definitions |

## Common Patterns

### Publishing a Message

```typescript
this.publish('task_assigned', targetAgentId, {
  id: taskId,
  type: 'develop_feature',
  title: 'Implement auth',
  description: 'Add JWT authentication',
});
```

### Waiting for Response

```typescript
const response = await this.request(
  'task_assigned',
  agentId,
  task,
  30000 // timeout
);
```

### Creating a Snapshot

```typescript
const snapshotId = await stateManager.createFullSnapshot({
  label: 'Before auth refactor',
  triggerReason: 'pre_edit',
  agentContexts: this.getAgentContexts(),
});
```

### Running Hooks

```typescript
const result = await hookRegistry.runPreToolUse('file_write', {
  path: '/src/auth.ts',
  content: '...',
});
if (!result.allowed) {
  throw new Error('Hook blocked operation');
}
```

### Context Compression

```typescript
// When history grows too large
const stats = this.getContextStats();
if (stats.estimatedTokens > 50000) {
  await this.compact({ focusHint: 'auth refactor' });
}
```

## Environment Variables

```bash
DEEPSEEK_API_KEY=sk-xxx    # Required: LLM API key
GITHUB_TOKEN=ghp_xxx       # Optional: Git push
MAX_CONCURRENCY=3          # Default: 3
VERBOSE=true               # Enable debug logs
```

## Project Configuration (ai-dev.json)

```json
{
  "name": "my-project",
  "techStack": {
    "language": "typescript",
    "frontend": "react"
  },
  "hooks": {
    "preToolUse": [
      { "command": "echo 'Checking...'", "blocking": false }
    ]
  }
}
```

---

*This document is maintained for AI assistants. Update when architecture changes.*
