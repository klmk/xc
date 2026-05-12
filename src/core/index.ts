/**
 * core/index.ts
 *
 * Barrel export for the AI Dev Platform core framework.
 * Re-exports all public types and classes from the core modules.
 */

// ─── Logger ──────────────────────────────────────────────────────────────────
export {
  Logger,
  ScopedLogger,
  defaultLogger,
} from './logger.js';
export type {
  LogLevel,
  LogEntry,
  LoggerOptions,
} from './logger.js';

// ─── Message Bus ─────────────────────────────────────────────────────────────
export { MessageBus } from './message-bus.js';
export type {
  MessageType,
  Message,
  MessageHandler,
  RequestOptions,
} from './message-bus.js';

// ─── Agent Base ──────────────────────────────────────────────────────────────
export { AgentBase } from './agent-base.js';
export type {
  AgentHistoryEntry,
  TaskDescriptor,
  TaskResult,
  ToolDefinition,
  ToolContext,
  ToolResult,
  AgentConfig,
  AgentStatus,
} from './agent-base.js';

// ─── Task Executor ───────────────────────────────────────────────────────────
export { TaskExecutor } from './task-executor.js';
export type {
  TaskNode,
  TaskStatus,
  TaskResult as ExecutorTaskResult,
  ExecutionResult,
  TaskExecutorOptions,
} from './task-executor.js';

// ─── Hooks ───────────────────────────────────────────────────────────────────
export { HookRegistry } from './hooks.js';
export type {
  HookType,
  HookFn,
  HookDefinition,
  HookContext,
  HookResult,
} from './hooks.js';

// ─── Project Config ──────────────────────────────────────────────────────────
export { ProjectConfigLoader } from './project-config.js';
export type {
  TechStackConfig,
  CodingStandardsConfig,
  AgentOverrideConfig,
  AgentsConfig,
  HookDefinition as ConfigHookDefinition,
  HooksConfig,
  TaskExecutorConfig,
  ProjectConfig,
} from './project-config.js';

// ─── State Manager ───────────────────────────────────────────────────────────
export { StateManager } from './state-manager.js';
export type {
  StateChangeEvent,
  SnapshotMeta,
  StateManagerOptions,
} from './state-manager.js';
