/**
 * core/agent-base.ts
 *
 * Abstract base class for all Agents in the platform. Inspired by Claude
 * Code's sub-agent architecture, each Agent owns:
 *   - An independent message history (context window)
 *   - An independent system prompt
 *   - A controlled set of tools it may invoke
 *   - A connection to the shared MessageBus
 *
 * Lifecycle:  initialize() -> execute(task) -> shutdown()
 *
 * Agents never share state directly; they communicate exclusively through
 * the MessageBus.
 *
 * Uses only Node.js built-ins.
 */

import { randomUUID } from 'node:crypto';
import type { MessageBus, Message, MessageType } from './message-bus.js';
import type { Logger, ScopedLogger } from './logger.js';
import { defaultLogger } from './logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A single entry in the agent's independent message history.
 */
export interface AgentHistoryEntry {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
  toolCallId?: string;
  timestamp: string;
}

/**
 * Task descriptor passed to `execute()`.
 */
export interface TaskDescriptor {
  id: string;
  type: string;
  title: string;
  description: string;
  payload?: Record<string, unknown>;
  parentTaskId?: string;
  correlationId?: string;
}

/**
 * Result returned by `execute()`.
 */
export interface TaskResult {
  success: boolean;
  outputs: Record<string, unknown>;
  artifacts: string[];
  logs: string[];
  error?: string;
}

/**
 * Tool definition that an agent can invoke.
 */
export interface ToolDefinition {
  /** Unique tool name */
  name: string;
  /** Human-readable description (used in prompts) */
  description: string;
  /** Parameter JSON schema (simplified) */
  parameters?: Record<string, unknown>;
  /** The actual execution function */
  execute: (params: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

/**
 * Context passed to tool execution functions.
 */
export interface ToolContext {
  agentId: string;
  taskId: string;
  messageBus: MessageBus;
  logger: ScopedLogger;
}

/**
 * Result from a tool invocation.
 */
export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  artifacts?: string[];
}

/**
 * Information about a sub-agent spawned by this agent.
 */
export interface SubAgentInfo {
  id: string;
  name: string;
  taskId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  result?: TaskResult;
}

/**
 * Configuration for creating an Agent.
 */
export interface AgentConfig {
  /** Unique agent identifier (default: auto-generated UUID) */
  id?: string;
  /** Human-readable agent name */
  name: string;
  /** System prompt that defines the agent's behaviour */
  systemPrompt: string;
  /** Maximum number of LLM iterations before giving up (default: 20) */
  maxIterations?: number;
  /** List of tools this agent is allowed to use */
  tools?: ToolDefinition[];
  /** Message types this agent subscribes to */
  subscribeTo?: MessageType[];
  /** LLM temperature override (default: 0.7) */
  temperature?: number;
  /** LLM max tokens override (default: 8192) */
  maxTokens?: number;
  /** Maximum history entries before auto-compaction (default: 200) */
  maxHistorySize?: number;
  /** Whether to auto-compact when history exceeds maxHistorySize (default: false) */
  autoCompact?: boolean;
}

/**
 * Agent lifecycle status.
 */
export type AgentStatus = 'uninitialized' | 'ready' | 'busy' | 'error' | 'shutdown';

// ─── Agent Base Class ────────────────────────────────────────────────────────

export abstract class AgentBase {
  /** Unique agent identifier */
  readonly id: string;
  /** Human-readable agent name */
  readonly name: string;
  /** System prompt */
  readonly systemPrompt: string;
  /** Maximum iterations */
  readonly maxIterations: number;
  /** LLM temperature */
  readonly temperature: number;
  /** LLM max tokens */
  readonly maxTokens: number;

  /** Shared message bus */
  protected messageBus: MessageBus;
  /** Logger scoped to this agent */
  protected logger: ScopedLogger;

  /** Independent message history (context window) */
  private history: AgentHistoryEntry[];
  /** Tools available to this agent */
  private tools: Map<string, ToolDefinition>;
  /** Unsubscribe functions for message bus subscriptions */
  private unsubscribers: Array<() => void>;
  /** Current agent status */
  private status: AgentStatus;
  /** Maximum history entries to keep */
  private maxHistorySize: number;
  /** Whether to auto-compact when history exceeds maxHistorySize */
  private autoCompact: boolean;
  /** Active task ID (when busy) */
  private activeTaskId: string | null;
  /** Sub-agents spawned by this agent */
  private subAgents: Map<string, SubAgentInfo>;
  /** Hook handlers for tool use lifecycle */
  private hookHandlers: {
    preToolUse?: (toolName: string, params: Record<string, unknown>) => Promise<boolean>;
    postToolUse?: (toolName: string, params: Record<string, unknown>, result: ToolResult) => Promise<void>;
  };

  constructor(config: AgentConfig, messageBus: MessageBus, logger?: Logger) {
    this.id = config.id ?? randomUUID();
    this.name = config.name;
    this.systemPrompt = config.systemPrompt;
    this.maxIterations = config.maxIterations ?? 20;
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.maxTokens ?? 8192;

    this.messageBus = messageBus;
    this.logger = (logger ?? defaultLogger).child(this.name);

    this.history = [];
    this.tools = new Map();
    this.unsubscribers = [];
    this.status = 'uninitialized';
    this.maxHistorySize = config.maxHistorySize ?? 200;
    this.autoCompact = config.autoCompact ?? false;
    this.activeTaskId = null;
    this.subAgents = new Map();
    this.hookHandlers = {};

    // Register tools
    if (config.tools) {
      for (const tool of config.tools) {
        this.tools.set(tool.name, tool);
      }
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Initialize the agent. Sets up message bus subscriptions and pushes the
   * system prompt into the agent's history. Must be called before `execute()`.
   */
  async initialize(): Promise<void> {
    if (this.status !== 'uninitialized') {
      this.logger.warn('Agent already initialized or shut down');
      return;
    }

    // Push system prompt into independent history
    this.addHistoryEntry({
      role: 'system',
      content: this.systemPrompt,
      timestamp: new Date().toISOString(),
    });

    // Subscribe to relevant message types
    this.subscribeToMessages();

    this.status = 'ready';
    this.logger.info('Agent initialized', { id: this.id, tools: this.getToolNames() });
  }

  /**
   * Execute a task. The agent processes the task using its independent
   * history and available tools. Subclasses MUST implement this method.
   */
  abstract execute(task: TaskDescriptor): Promise<TaskResult>;

  /**
   * Shut down the agent. Unsubscribes from the message bus and clears history.
   */
  async shutdown(): Promise<void> {
    // Unsubscribe from all message types
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    this.history = [];
    this.activeTaskId = null;
    this.status = 'shutdown';

    this.logger.info('Agent shut down');
  }

  // ─── Status ─────────────────────────────────────────────────────────────

  /**
   * Get the current agent status.
   */
  getStatus(): AgentStatus {
    return this.status;
  }

  /**
   * Check whether the agent is ready to accept a task.
   */
  isReady(): boolean {
    return this.status === 'ready';
  }

  /**
   * Check whether the agent is currently executing a task.
   */
  isBusy(): boolean {
    return this.status === 'busy';
  }

  // ─── History Management ─────────────────────────────────────────────────

  /**
   * Get a read-only copy of the agent's message history.
   */
  getHistory(): ReadonlyArray<AgentHistoryEntry> {
    return [...this.history];
  }

  /**
   * Get the number of entries in the history.
   */
  getHistorySize(): number {
    return this.history.length;
  }

  /**
   * Clear the agent's message history (except the system prompt).
   */
  clearHistory(): void {
    // Keep the system prompt
    const systemEntries = this.history.filter((e) => e.role === 'system');
    this.history = systemEntries;
    this.logger.debug('History cleared (system prompt retained)');
  }

  /**
   * Trim the history to the most recent N entries (plus system prompts).
   * Useful for managing context window size.
   */
  trimHistory(maxEntries: number): void {
    const systemEntries = this.history.filter((e) => e.role === 'system');
    const nonSystemEntries = this.history.filter((e) => e.role !== 'system');

    if (nonSystemEntries.length > maxEntries) {
      const trimmed = nonSystemEntries.slice(-maxEntries);
      this.history = [...systemEntries, ...trimmed];
      this.logger.debug('History trimmed', {
        before: nonSystemEntries.length,
        after: trimmed.length,
      });
    }
  }

  /**
   * Compress the agent's history to reduce context window usage.
   * Strategy:
   *   1. Keep all system prompts
   *   2. Keep the most recent N entries (configurable, default 20)
   *   3. Summarize older entries into a single summary entry
   *   4. Remove tool outputs from old entries (they're usually large)
   *
   * @param options.focusHint - Optional hint about what to focus on (e.g., "focus on auth refactor")
   * @param options.keepRecent - Number of recent entries to keep intact (default 20)
   * @param options.summarizer - Optional function to summarize old entries. If not provided, a default summarizer is used.
   * @returns A summary of what was compressed
   */
  async compact(options?: {
    focusHint?: string;
    keepRecent?: number;
    summarizer?: (entries: AgentHistoryEntry[]) => Promise<string>;
  }): Promise<{ entriesBefore: number; entriesAfter: number; summary: string }> {
    const keepRecent = options?.keepRecent ?? 20;
    const entriesBefore = this.history.length;

    const systemEntries = this.history.filter((e) => e.role === 'system');
    const nonSystemEntries = this.history.filter((e) => e.role !== 'system');

    // If history is small enough, nothing to compress
    if (nonSystemEntries.length <= keepRecent) {
      return {
        entriesBefore,
        entriesAfter: entriesBefore,
        summary: 'History is within the keep-recent limit; nothing to compress.',
      };
    }

    // Split into old (to compress) and recent (to keep intact)
    const oldEntries = nonSystemEntries.slice(0, -keepRecent);
    const recentEntries = nonSystemEntries.slice(-keepRecent);

    // Strip large tool outputs from old entries to reduce memory during summarization
    const strippedOldEntries = oldEntries.map((entry) => {
      if (entry.role === 'tool' && entry.content.length > 500) {
        return {
          ...entry,
          content: entry.content.substring(0, 500) + '... [truncated for compaction]',
        };
      }
      return entry;
    });

    // Summarize old entries
    const summarizer = options?.summarizer ?? this.defaultSummarizer;
    const summary = await summarizer(strippedOldEntries);

    // Build focus hint prefix if provided
    const focusPrefix = options?.focusHint
      ? `[Compaction focus: ${options.focusHint}]\n`
      : '';

    // Reconstruct history: system entries + compressed summary + recent entries
    const compressedEntry: AgentHistoryEntry = {
      role: 'user',
      content: `${focusPrefix}${summary}`,
      timestamp: new Date().toISOString(),
    };

    this.history = [...systemEntries, compressedEntry, ...recentEntries];

    const entriesAfter = this.history.length;

    this.logger.info('History compacted', {
      entriesBefore,
      entriesAfter,
      compressedEntries: oldEntries.length,
      keptRecent: recentEntries.length,
    });

    return {
      entriesBefore,
      entriesAfter,
      summary,
    };
  }

  /**
   * Get the current context usage statistics.
   */
  getContextStats(): {
    totalEntries: number;
    systemEntries: number;
    userEntries: number;
    assistantEntries: number;
    toolEntries: number;
    estimatedTokens: number; // Rough estimate: ~4 chars per token
  } {
    let systemEntries = 0;
    let userEntries = 0;
    let assistantEntries = 0;
    let toolEntries = 0;
    let totalChars = 0;

    for (const entry of this.history) {
      totalChars += entry.content.length;
      switch (entry.role) {
        case 'system':
          systemEntries++;
          break;
        case 'user':
          userEntries++;
          break;
        case 'assistant':
          assistantEntries++;
          break;
        case 'tool':
          toolEntries++;
          break;
      }
    }

    return {
      totalEntries: this.history.length,
      systemEntries,
      userEntries,
      assistantEntries,
      toolEntries,
      estimatedTokens: Math.ceil(totalChars / 4),
    };
  }

  /**
   * Default summarizer that creates a concise summary of old history entries.
   * Groups entries by type, extracts tool names and file paths, and produces
   * a structured summary string.
   */
  private async defaultSummarizer(entries: AgentHistoryEntry[]): Promise<string> {
    let userCount = 0;
    let assistantCount = 0;
    let toolCount = 0;
    const toolUsage = new Map<string, number>();
    const filePaths = new Set<string>();

    for (const entry of entries) {
      switch (entry.role) {
        case 'user':
          userCount++;
          break;
        case 'assistant':
          assistantCount++;
          break;
        case 'tool':
          toolCount++;
          if (entry.toolName) {
            toolUsage.set(entry.toolName, (toolUsage.get(entry.toolName) ?? 0) + 1);
          }
          break;
      }

      // Extract file paths from content (common patterns)
      const pathMatches = entry.content.match(/[\w./-]+\.\w{1,5}(?:\.\w+)?/g);
      if (pathMatches) {
        for (const p of pathMatches) {
          // Only consider paths that look like file paths (contain / or .)
          if (p.includes('/') || p.includes('\\')) {
            filePaths.add(p);
          }
        }
      }
    }

    const lines: string[] = ['[Compressed context summary]'];
    lines.push(`- ${userCount} user messages, ${assistantCount} assistant responses, ${toolCount} tool calls`);

    // Tool usage summary
    if (toolUsage.size > 0) {
      const toolParts: string[] = [];
      for (const [name, count] of toolUsage) {
        toolParts.push(`${name}(${count})`);
      }
      lines.push(`- Tools used: ${toolParts.join(', ')}`);
    }

    // File paths summary (limit to avoid bloat)
    if (filePaths.size > 0) {
      const uniquePaths = Array.from(filePaths).slice(0, 10);
      lines.push(`- Files discussed: ${uniquePaths.join(', ')}`);
      if (filePaths.size > 10) {
        lines.push(`- ... and ${filePaths.size - 10} more files`);
      }
    }

    return lines.join('\n');
  }

  // ─── Tool Management ────────────────────────────────────────────────────

  /**
   * Get the names of all registered tools.
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Check whether a tool is available.
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get a tool definition by name.
   */
  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Register an additional tool at runtime.
   */
  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
    this.logger.debug('Tool registered', { tool: tool.name });
  }

  /**
   * Unregister a tool by name.
   */
  unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Execute a tool by name with the given parameters.
   * Returns the tool result or throws if the tool is not found.
   */
  async invokeTool(
    name: string,
    params: Record<string, unknown>,
    taskId: string,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        output: '',
        error: `Tool not found: ${name}`,
      };
    }

    this.logger.debug('Invoking tool', { tool: name, params });

    // Fire pre-tool-use hook; abort if not allowed
    const allowed = await this.firePreToolUseHook(name, params);
    if (!allowed) {
      this.logger.info('Tool use blocked by preToolUse hook', { tool: name });
      return {
        success: false,
        output: '',
        error: `Tool use blocked by hook: ${name}`,
      };
    }

    // Record the tool call in history
    const toolCallId = randomUUID();
    this.addHistoryEntry({
      role: 'assistant',
      content: `Calling tool: ${name}`,
      toolName: name,
      toolCallId,
      timestamp: new Date().toISOString(),
    });

    try {
      const result = await tool.execute(params, {
        agentId: this.id,
        taskId,
        messageBus: this.messageBus,
        logger: this.logger,
      });

      // Record the tool result in history
      this.addHistoryEntry({
        role: 'tool',
        content: result.success ? result.output : `Error: ${result.error}`,
        toolName: name,
        toolCallId,
        timestamp: new Date().toISOString(),
      });

      // Fire post-tool-use hook
      await this.firePostToolUseHook(name, params, result);

      return result;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      this.addHistoryEntry({
        role: 'tool',
        content: `Error: ${errorMessage}`,
        toolName: name,
        toolCallId,
        timestamp: new Date().toISOString(),
      });

      return {
        success: false,
        output: '',
        error: errorMessage,
      };
    }
  }

  /**
   * Generate a description of available tools for inclusion in prompts.
   */
  getToolDescriptions(): string {
    const lines: string[] = [];
    for (const [name, tool] of this.tools) {
      lines.push(`- ${name}: ${tool.description}`);
      if (tool.parameters) {
        lines.push(`  Parameters: ${JSON.stringify(tool.parameters)}`);
      }
    }
    return lines.join('\n');
  }

  // ─── Message Bus Helpers ────────────────────────────────────────────────

  /**
   * Publish a message to the bus.
   */
  protected publish<P = unknown>(
    type: MessageType,
    to: string,
    payload: P,
    correlationId?: string,
  ): Message<P> {
    return this.messageBus.publish(type, this.id, to, payload, correlationId);
  }

  /**
   * Send a request and wait for a response.
   */
  protected async request<P = unknown, R = unknown>(
    type: MessageType,
    to: string,
    payload: P,
    timeout?: number,
  ): Promise<Message<R>> {
    return this.messageBus.request<P, R>({
      type,
      from: this.id,
      to,
      payload,
      timeout,
    });
  }

  /**
   * Reply to a previously received message.
   */
  protected respond<R = unknown>(
    originalMessage: Message,
    replyType: MessageType,
    payload: R,
  ): Message<R> {
    return this.messageBus.respond(originalMessage, replyType, payload);
  }

  /**
   * Delegate a task to a sub-agent. Sends a task_assigned message and waits
   * for either task_completed or task_failed in response.
   *
   * This is the core of Claude Code's sub-agent pattern: the parent agent
   * delegates work to a specialist child agent and waits for the result.
   */
  protected async delegateToSubAgent(
    targetAgentId: string,
    task: TaskDescriptor,
    timeout?: number,
  ): Promise<TaskResult> {
    this.logger.info('Delegating task to sub-agent', {
      target: targetAgentId,
      task: task.title,
    });

    const response = await this.request(
      'task_assigned',
      targetAgentId,
      task,
      timeout,
    );

    if (response.type === 'task_completed') {
      return response.payload as unknown as TaskResult;
    }

    if (response.type === 'task_failed') {
      const failPayload = response.payload as { error?: string };
      return {
        success: false,
        outputs: {},
        artifacts: [],
        logs: [`Sub-agent ${targetAgentId} failed: ${failPayload.error ?? 'unknown error'}`],
        error: failPayload.error ?? 'Sub-agent task failed',
      };
    }

    // Unexpected response type
    return {
      success: false,
      outputs: {},
      artifacts: [],
      logs: [`Unexpected response from sub-agent: ${response.type}`],
      error: `Unexpected response type: ${response.type}`,
    };
  }

  // ─── Sub-Agent Lifecycle ───────────────────────────────────────────────

  /**
   * Get all sub-agents spawned by this agent.
   */
  getSubAgents(): ReadonlyArray<SubAgentInfo> {
    return Array.from(this.subAgents.values());
  }

  /**
   * Cancel a running sub-agent by ID.
   * Marks the sub-agent as cancelled and publishes a cancellation message.
   */
  cancelSubAgent(subAgentId: string): void {
    const subAgent = this.subAgents.get(subAgentId);
    if (!subAgent) {
      this.logger.warn('Cannot cancel sub-agent: not found', { subAgentId });
      return;
    }

    if (subAgent.status !== 'running') {
      this.logger.warn('Cannot cancel sub-agent: not running', {
        subAgentId,
        status: subAgent.status,
      });
      return;
    }

    subAgent.status = 'cancelled';
    subAgent.completedAt = new Date().toISOString();

    // Notify the sub-agent via the message bus
    this.publish('subagent_cancel', subAgentId, {
      taskId: subAgent.taskId,
      cancelledBy: this.id,
    });

    this.logger.info('Sub-agent cancelled', { subAgentId, taskId: subAgent.taskId });
  }

  /**
   * Track a newly spawned sub-agent. Called internally when delegating.
   */
  protected trackSubAgent(info: SubAgentInfo): void {
    this.subAgents.set(info.id, info);
    this.logger.debug('Sub-agent tracked', { id: info.id, name: info.name });
  }

  /**
   * Update a sub-agent's status after completion or failure.
   */
  protected updateSubAgentStatus(
    subAgentId: string,
    status: 'completed' | 'failed' | 'cancelled',
    result?: TaskResult,
  ): void {
    const subAgent = this.subAgents.get(subAgentId);
    if (!subAgent) {
      this.logger.warn('Cannot update sub-agent: not found', { subAgentId });
      return;
    }

    subAgent.status = status;
    subAgent.completedAt = new Date().toISOString();
    if (result) {
      subAgent.result = result;
    }
  }

  // ─── Protected Helpers ─────────────────────────────────────────────────

  /**
   * Set the agent status. Protected so subclasses can update status.
   */
  protected setStatus(status: AgentStatus): void {
    this.status = status;
  }

  /**
   * Set the active task ID when the agent starts working.
   */
  protected setActiveTask(taskId: string | null): void {
    this.activeTaskId = taskId;
  }

  /**
   * Get the active task ID.
   */
  protected getActiveTaskId(): string | null {
    return this.activeTaskId;
  }

  /**
   * Add an entry to the agent's message history.
   */
  protected addHistoryEntry(entry: AgentHistoryEntry): void {
    this.history.push(entry);

    // Auto-compact if enabled and history exceeds max size
    if (this.autoCompact && this.history.length > this.maxHistorySize) {
      this.compact().catch((err: unknown) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.logger.error('Auto-compaction failed', { error: errorMessage });
      });
      return;
    }

    // Enforce max history size (keep system prompts) when auto-compact is off
    if (!this.autoCompact && this.history.length > this.maxHistorySize) {
      const systemEntries = this.history.filter((e) => e.role === 'system');
      const nonSystemEntries = this.history.filter((e) => e.role !== 'system');
      const trimmed = nonSystemEntries.slice(-(this.maxHistorySize - systemEntries.length));
      this.history = [...systemEntries, ...trimmed];
    }
  }

  /**
   * Add a user message to history (e.g., from a task descriptor).
   */
  protected addUserMessage(content: string): void {
    this.addHistoryEntry({
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Add an assistant message to history (e.g., LLM response).
   */
  protected addAssistantMessage(content: string): void {
    this.addHistoryEntry({
      role: 'assistant',
      content,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Build the full message array from history for LLM consumption.
   * Filters out tool-specific metadata and returns clean messages.
   */
  protected buildLLMMessages(): Array<{ role: string; content: string }> {
    return this.history.map((entry) => ({
      role: entry.role,
      content: entry.content,
    }));
  }

  /**
   * Create a TaskResult indicating success.
   */
  protected createSuccessResult(
    outputs: Record<string, unknown>,
    artifacts: string[],
    logs: string[],
  ): TaskResult {
    return { success: true, outputs, artifacts, logs };
  }

  /**
   * Create a TaskResult indicating failure.
   */
  protected createFailureResult(error: string, logs?: string[]): TaskResult {
    return {
      success: false,
      outputs: {},
      artifacts: [],
      logs: logs ?? [`Error: ${error}`],
      error,
    };
  }

  // ─── Hook Integration ──────────────────────────────────────────────────

  /**
   * Set hook handlers. Used by the platform to inject hook execution.
   */
  setHookHandlers(handlers?: {
    preToolUse?: (toolName: string, params: Record<string, unknown>) => Promise<boolean>;
    postToolUse?: (toolName: string, params: Record<string, unknown>, result: ToolResult) => Promise<void>;
  }): void {
    this.hookHandlers = handlers ?? {};
  }

  /**
   * Fire a preToolUse hook. Returns true if the tool use is allowed.
   */
  protected async firePreToolUseHook(toolName: string, params: Record<string, unknown>): Promise<boolean> {
    if (!this.hookHandlers.preToolUse) {
      return true;
    }
    try {
      return await this.hookHandlers.preToolUse(toolName, params);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error('preToolUse hook error', { toolName, error: errorMessage });
      // Default to allowing tool use if hook errors
      return true;
    }
  }

  /**
   * Fire a postToolUse hook.
   */
  protected async firePostToolUseHook(toolName: string, params: Record<string, unknown>, result: ToolResult): Promise<void> {
    if (!this.hookHandlers.postToolUse) {
      return;
    }
    try {
      await this.hookHandlers.postToolUse(toolName, params, result);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error('postToolUse hook error', { toolName, error: errorMessage });
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────

  /**
   * Subscribe to message types. By default, the base agent subscribes to
   * nothing. Subclasses should override `getSubscribedMessageTypes()` to
   * declare which messages they care about, or the config can specify them.
   */
  private subscribeToMessages(): void {
    const types = this.getSubscribedMessageTypes();

    for (const type of types) {
      const unsub = this.messageBus.subscribe(type, (message: Message) => {
        this.handleMessage(message).catch((err: Error) => {
          this.logger.error('Error handling message', {
            type: message.type,
            error: err.message,
          });
        });
      });
      this.unsubscribers.push(unsub);
    }
  }

  /**
   * Return the message types this agent subscribes to.
   * Override in subclasses to add custom subscriptions.
   */
  protected getSubscribedMessageTypes(): MessageType[] {
    return [];
  }

  /**
   * Handle an incoming message from the bus. Override in subclasses to
   * implement custom message handling logic.
   */
  protected async handleMessage(_message: Message): Promise<void> {
    // Default: no-op. Subclasses override to handle specific messages.
  }
}
