/**
 * core/hooks.ts
 *
 * Hook system inspired by Claude Code. Hooks allow project-level customisation
 * of the agent lifecycle by running shell commands or JavaScript functions at
 * well-defined points:
 *
 *   Session lifecycle:
 *     - sessionStart            : when a development session begins or resumes
 *     - sessionEnd              : when a development session terminates
 *     - setup                   : project initialisation (--init)
 *
 *   Turn lifecycle:
 *     - userPromptSubmit        : after user submits prompt, before Claude processes
 *     - userPromptExpansion     : after prompt expansion
 *     - stop                    : Claude finishes response
 *     - stopFailure             : turn ended due to API error
 *
 *   Tool execution:
 *     - preToolUse              : before a tool is invoked (CAN BLOCK)
 *     - postToolUse             : after a tool succeeds
 *     - postToolUseFailure      : after a tool fails
 *     - postToolBatch           : after parallel tool batch completes
 *     - permissionRequest       : permission dialog appears
 *     - permissionDenied        : tool denied by auto-mode classifier
 *
 *   Sub-agent lifecycle:
 *     - subagentStart           : sub-agent created
 *     - subagentStop            : sub-agent completes
 *
 *   Context management:
 *     - preCompact              : before context compression
 *     - postCompact             : after context compression
 *
 *   Task lifecycle:
 *     - taskCreated             : task created via TaskCreate
 *     - taskCompleted           : task marked complete
 *
 *   File & config:
 *     - instructionsLoaded      : CLAUDE.md / rules loaded
 *     - configChange            : config changed during session
 *     - cwdChanged              : working directory changed
 *     - fileChanged             : monitored file changed on disk
 *
 *   Worktree:
 *     - worktreeCreate          : worktree created
 *     - worktreeRemove          : worktree removed
 *
 *   Notification:
 *     - notification            : Claude Code sends notification
 *
 * Hooks can:
 *   - Allow an action to proceed (exit 0)
 *   - Block an action (exit non-zero, or throw)
 *   - Modify context by returning JSON on stdout
 *
 * Configuration is loaded from the project's `ai-dev.json` (via
 * `ProjectConfigLoader`). This module only handles execution.
 *
 * Uses only Node.js built-ins.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger, ScopedLogger } from './logger.js';
import { defaultLogger } from './logger.js';

const execAsync = promisify(exec);

// ─── Hook Types ──────────────────────────────────────────────────────────────

export type HookType =
  // Session lifecycle (3)
  | 'sessionStart'          // Session begins or resumes
  | 'sessionEnd'            // Session terminates
  | 'setup'                 // Project initialization (--init)

  // Turn lifecycle (4)
  | 'userPromptSubmit'      // After user submits prompt, before Claude processes
  | 'userPromptExpansion'   // After prompt expansion
  | 'stop'                  // Claude finishes response
  | 'stopFailure'           // Turn ended due to API error

  // Tool execution (6)
  | 'preToolUse'            // Before tool executes (CAN BLOCK)
  | 'postToolUse'           // After tool succeeds
  | 'postToolUseFailure'    // After tool fails
  | 'postToolBatch'         // After parallel tool batch completes
  | 'permissionRequest'     // Permission dialog appears
  | 'permissionDenied'      // Tool denied by auto-mode classifier

  // Sub-agent lifecycle (2)
  | 'subagentStart'         // Sub-agent created
  | 'subagentStop'          // Sub-agent completes

  // Context management (2)
  | 'preCompact'            // Before context compression
  | 'postCompact'           // After context compression

  // Task lifecycle (2)
  | 'taskCreated'           // Task created via TaskCreate
  | 'taskCompleted'         // Task marked complete

  // File & config (4)
  | 'instructionsLoaded'    // CLAUDE.md / rules loaded
  | 'configChange'          // Config changed during session
  | 'cwdChanged'            // Working directory changed
  | 'fileChanged'           // Monitored file changed on disk

  // Worktree (2)
  | 'worktreeCreate'        // Worktree created
  | 'worktreeRemove'        // Worktree removed

  // Notification (1)
  | 'notification';         // Claude Code sends notification

/**
 * Backward-compatible aliases for legacy hook type names.
 * These map old names to their canonical new equivalents.
 */
export const HOOK_TYPE_ALIASES: Readonly<Record<string, HookType>> = {
  /** @deprecated Use 'sessionStart' instead */
  SessionStart: 'sessionStart',
  /** @deprecated Use 'preToolUse' instead */
  PreToolUse: 'preToolUse',
  /** @deprecated Use 'postToolUse' instead */
  PostToolUse: 'postToolUse',
  /** @deprecated Use 'preCommit' mapped to 'preToolUse' with matchTool */
  PreCommit: 'preToolUse',
  /** @deprecated Use 'postTest' mapped to 'postToolUse' with matchTool */
  PostTest: 'postToolUse',
  /** @deprecated Use 'stopFailure' instead */
  OnError: 'stopFailure',
};

// ─── Hook Definition ─────────────────────────────────────────────────────────

/**
 * A hook can be a shell command string or a JS function.
 */
export type HookFn = (context: HookContext) => Promise<HookResult>;

export interface HookDefinition {
  /** Shell command to execute (mutually exclusive with `fn`) */
  command?: string;
  /** In-process JavaScript function (mutually exclusive with `command`) */
  fn?: HookFn;
  /** Timeout in milliseconds (default: 30 000) */
  timeout?: number;
  /** Whether a non-zero exit blocks the action (default: false) */
  blocking?: boolean;
  /** Glob pattern to match specific tool names (only for preToolUse / postToolUse) */
  matchTool?: string;
  /** Generic matcher expression, e.g. "Bash(rm *)" or "Write(src/**)" */
  matcher?: string;
}

// ─── Hook Context ────────────────────────────────────────────────────────────

/**
 * Context passed to every hook execution.
 */
export interface HookContext {
  /** Which hook point is being triggered */
  hookType: HookType;
  /** Name of the tool being invoked (preToolUse / postToolUse only) */
  toolName?: string;
  /** Parameters passed to the tool */
  toolParams?: Record<string, unknown>;
  /** Tool execution result (postToolUse only) */
  toolResult?: {
    success: boolean;
    output: string;
    error?: string;
  };
  /** Test results (postTest only) */
  testResults?: {
    total: number;
    passed: number;
    failed: number;
  };
  /** Error information (onError / stopFailure only) */
  error?: {
    message: string;
    stack?: string;
  };
  /** Arbitrary project-level data */
  projectData?: Record<string, unknown>;
  /** Working directory for shell commands */
  cwd?: string;
  /** Environment variables to pass to shell commands */
  env?: Record<string, string>;
  /** Which agent triggered the hook */
  agentId?: string;
  /** Human-readable agent name */
  agentName?: string;
  /** Sub-agent ID (for subagentStart / subagentStop) */
  subagentId?: string;
  /** Task ID (for taskCreated / taskCompleted) */
  taskId?: string;
  /** Task title */
  taskTitle?: string;
  /** File path (for fileChanged, preToolUse with file ops) */
  filePath?: string;
  /** Worktree path (for worktree events) */
  worktreePath?: string;
  /** Compression focus hint (for preCompact) */
  compactHint?: string;
  /** Notification content */
  notificationMessage?: string;
  /** For permissionDenied: can set retry: true */
  permissionDecision?: 'allow' | 'deny' | 'retry';
}

// ─── Hook Result ─────────────────────────────────────────────────────────────

export interface HookResult {
  /** Whether the hook allows the action to proceed */
  allowed: boolean;
  /** Human-readable message (shown to user / logged) */
  message?: string;
  /** Data returned by the hook (merged back into context) */
  data?: Record<string, unknown>;
  /** Modified tool parameters (preToolUse can change what the tool receives) */
  modifiedParams?: Record<string, unknown>;
}

// ─── Hook Registry ───────────────────────────────────────────────────────────

/**
 * Manages hook registration and execution.
 */
export class HookRegistry {
  private hooks: Map<HookType, HookDefinition[]>;
  private logger: ScopedLogger;
  private defaultCwd: string;
  private defaultEnv: Record<string, string>;

  constructor(options?: { logger?: Logger; cwd?: string }) {
    this.hooks = new Map();
    this.logger = (options?.logger ?? defaultLogger).child('hooks');
    this.defaultCwd = options?.cwd ?? process.cwd();
    this.defaultEnv = { ...process.env } as Record<string, string>;

    // Initialise empty arrays for all hook types
    const types: HookType[] = [
      // Session lifecycle
      'sessionStart',
      'sessionEnd',
      'setup',
      // Turn lifecycle
      'userPromptSubmit',
      'userPromptExpansion',
      'stop',
      'stopFailure',
      // Tool execution
      'preToolUse',
      'postToolUse',
      'postToolUseFailure',
      'postToolBatch',
      'permissionRequest',
      'permissionDenied',
      // Sub-agent lifecycle
      'subagentStart',
      'subagentStop',
      // Context management
      'preCompact',
      'postCompact',
      // Task lifecycle
      'taskCreated',
      'taskCompleted',
      // File & config
      'instructionsLoaded',
      'configChange',
      'cwdChanged',
      'fileChanged',
      // Worktree
      'worktreeCreate',
      'worktreeRemove',
      // Notification
      'notification',
    ];
    for (const type of types) {
      this.hooks.set(type, []);
    }
  }

  // ─── Registration ───────────────────────────────────────────────────────

  /**
   * Register a hook for a given hook type.
   */
  register(hookType: HookType, definition: HookDefinition): void {
    const list = this.hooks.get(hookType);
    if (!list) {
      throw new Error(`Unknown hook type: ${hookType}`);
    }
    list.push(definition);
    this.logger.debug('Hook registered', { hookType, command: definition.command, blocking: definition.blocking });
  }

  /**
   * Register multiple hooks at once from a partial config object.
   * Mirrors the shape of `HooksConfig` from `project-config.ts`.
   *
   * Accepts all 26 hook types as optional arrays of HookDefinition.
   */
  registerFromConfig(config: {
    sessionStart?: HookDefinition[];
    sessionEnd?: HookDefinition[];
    setup?: HookDefinition[];
    userPromptSubmit?: HookDefinition[];
    userPromptExpansion?: HookDefinition[];
    stop?: HookDefinition[];
    stopFailure?: HookDefinition[];
    preToolUse?: HookDefinition[];
    postToolUse?: HookDefinition[];
    postToolUseFailure?: HookDefinition[];
    postToolBatch?: HookDefinition[];
    permissionRequest?: HookDefinition[];
    permissionDenied?: HookDefinition[];
    subagentStart?: HookDefinition[];
    subagentStop?: HookDefinition[];
    preCompact?: HookDefinition[];
    postCompact?: HookDefinition[];
    taskCreated?: HookDefinition[];
    taskCompleted?: HookDefinition[];
    instructionsLoaded?: HookDefinition[];
    configChange?: HookDefinition[];
    cwdChanged?: HookDefinition[];
    fileChanged?: HookDefinition[];
    worktreeCreate?: HookDefinition[];
    worktreeRemove?: HookDefinition[];
    notification?: HookDefinition[];
  }): void {
    const mapping: Array<[HookType, HookDefinition[] | undefined]> = [
      ['sessionStart', config.sessionStart],
      ['sessionEnd', config.sessionEnd],
      ['setup', config.setup],
      ['userPromptSubmit', config.userPromptSubmit],
      ['userPromptExpansion', config.userPromptExpansion],
      ['stop', config.stop],
      ['stopFailure', config.stopFailure],
      ['preToolUse', config.preToolUse],
      ['postToolUse', config.postToolUse],
      ['postToolUseFailure', config.postToolUseFailure],
      ['postToolBatch', config.postToolBatch],
      ['permissionRequest', config.permissionRequest],
      ['permissionDenied', config.permissionDenied],
      ['subagentStart', config.subagentStart],
      ['subagentStop', config.subagentStop],
      ['preCompact', config.preCompact],
      ['postCompact', config.postCompact],
      ['taskCreated', config.taskCreated],
      ['taskCompleted', config.taskCompleted],
      ['instructionsLoaded', config.instructionsLoaded],
      ['configChange', config.configChange],
      ['cwdChanged', config.cwdChanged],
      ['fileChanged', config.fileChanged],
      ['worktreeCreate', config.worktreeCreate],
      ['worktreeRemove', config.worktreeRemove],
      ['notification', config.notification],
    ];

    for (const [type, defs] of mapping) {
      if (defs) {
        for (const def of defs) {
          this.register(type, def);
        }
      }
    }
  }

  /**
   * Remove all hooks for a given type, or all hooks if no type is specified.
   */
  clear(hookType?: HookType): void {
    if (hookType) {
      this.hooks.set(hookType, []);
    } else {
      for (const type of this.hooks.keys()) {
        this.hooks.set(type, []);
      }
    }
  }

  /**
   * Get all registered hooks for a given type.
   */
  getHooks(hookType: HookType): ReadonlyArray<HookDefinition> {
    return this.hooks.get(hookType) ?? [];
  }

  // ─── Execution ──────────────────────────────────────────────────────────

  /**
   * Run all hooks registered for a given hook type.
   *
   * Hooks are executed sequentially in registration order. If a blocking
   * hook returns `allowed: false`, subsequent hooks for that type are
   * skipped and the overall result is `allowed: false`.
   *
   * Returns the aggregated result.
   */
  async run(hookType: HookType, context: HookContext): Promise<HookResult> {
    const definitions = this.hooks.get(hookType) ?? [];

    if (definitions.length === 0) {
      return { allowed: true };
    }

    this.logger.debug(`Running ${definitions.length} ${hookType} hook(s)`);

    const messages: string[] = [];
    let mergedData: Record<string, unknown> = {};
    let modifiedParams: Record<string, unknown> | undefined;

    for (const def of definitions) {
      // For tool-specific hooks, check the matchTool glob
      if (def.matchTool && context.toolName) {
        if (!this.matchGlob(def.matchTool, context.toolName)) {
          continue;
        }
      }

      // For generic matcher expressions
      if (def.matcher) {
        if (!this.matchExpression(def.matcher, context)) {
          continue;
        }
      }

      try {
        const result = await this.executeHook(def, context);

        if (result.message) {
          messages.push(result.message);
        }

        if (result.data) {
          mergedData = { ...mergedData, ...result.data };
        }

        if (result.modifiedParams) {
          modifiedParams = modifiedParams
            ? { ...modifiedParams, ...result.modifiedParams }
            : result.modifiedParams;
        }

        if (!result.allowed && def.blocking) {
          this.logger.warn(`Blocking hook stopped action`, {
            hookType,
            message: result.message,
          });
          return {
            allowed: false,
            message: messages.join('\n'),
            data: mergedData,
            modifiedParams,
          };
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.logger.error(`Hook execution error`, {
          hookType,
          command: def.command,
          error: errorMessage,
        });
        messages.push(`Hook error: ${errorMessage}`);

        if (def.blocking) {
          return {
            allowed: false,
            message: messages.join('\n'),
            data: mergedData,
            modifiedParams,
          };
        }
      }
    }

    return {
      allowed: true,
      message: messages.length > 0 ? messages.join('\n') : undefined,
      data: Object.keys(mergedData).length > 0 ? mergedData : undefined,
      modifiedParams,
    };
  }

  // ─── Convenience: Session lifecycle ─────────────────────────────────────

  /**
   * Convenience: run sessionStart hooks.
   */
  async runSessionStart(cwd?: string, projectData?: Record<string, unknown>): Promise<HookResult> {
    return this.run('sessionStart', {
      hookType: 'sessionStart',
      cwd: cwd ?? this.defaultCwd,
      projectData,
    });
  }

  /**
   * Convenience: run sessionEnd hooks.
   */
  async runSessionEnd(cwd?: string, projectData?: Record<string, unknown>): Promise<HookResult> {
    return this.run('sessionEnd', {
      hookType: 'sessionEnd',
      cwd: cwd ?? this.defaultCwd,
      projectData,
    });
  }

  // ─── Convenience: Tool execution ────────────────────────────────────────

  /**
   * Convenience: run preToolUse hooks.
   */
  async runPreToolUse(
    toolName: string,
    params: Record<string, unknown>,
    cwd?: string,
  ): Promise<HookResult> {
    return this.run('preToolUse', {
      hookType: 'preToolUse',
      toolName,
      toolParams: params,
      cwd: cwd ?? this.defaultCwd,
    });
  }

  /**
   * Convenience: run postToolUse hooks.
   */
  async runPostToolUse(
    toolName: string,
    params: Record<string, unknown>,
    result: { success: boolean; output: string; error?: string },
    cwd?: string,
  ): Promise<HookResult> {
    return this.run('postToolUse', {
      hookType: 'postToolUse',
      toolName,
      toolParams: params,
      toolResult: result,
      cwd: cwd ?? this.defaultCwd,
    });
  }

  // ─── Convenience: Legacy hooks ──────────────────────────────────────────

  /**
   * Convenience: run preCommit hooks.
   * Maps to preToolUse with toolName 'git_commit'.
   */
  async runPreCommit(cwd?: string): Promise<HookResult> {
    return this.run('preToolUse', {
      hookType: 'preToolUse',
      toolName: 'git_commit',
      cwd: cwd ?? this.defaultCwd,
    });
  }

  /**
   * Convenience: run postTest hooks.
   */
  async runPostTest(
    testResults: { total: number; passed: number; failed: number },
    cwd?: string,
  ): Promise<HookResult> {
    return this.run('postToolUse', {
      hookType: 'postToolUse',
      toolName: 'test_runner',
      testResults,
      cwd: cwd ?? this.defaultCwd,
    });
  }

  /**
   * Convenience: run onError hooks.
   * Maps to stopFailure for backward compatibility.
   */
  async runOnError(
    error: Error,
    cwd?: string,
  ): Promise<HookResult> {
    return this.run('stopFailure', {
      hookType: 'stopFailure',
      error: {
        message: error.message,
        stack: error.stack,
      },
      cwd: cwd ?? this.defaultCwd,
    });
  }

  // ─── Convenience: Sub-agent lifecycle ───────────────────────────────────

  /**
   * Convenience: run subagentStart hooks.
   */
  async runSubagentStart(agentId: string, agentName?: string, cwd?: string): Promise<HookResult> {
    return this.run('subagentStart', {
      hookType: 'subagentStart',
      agentId,
      agentName,
      cwd: cwd ?? this.defaultCwd,
    });
  }

  /**
   * Convenience: run subagentStop hooks.
   */
  async runSubagentStop(
    agentId: string,
    result?: { success: boolean; output?: string; error?: string },
    cwd?: string,
  ): Promise<HookResult> {
    return this.run('subagentStop', {
      hookType: 'subagentStop',
      agentId,
      toolResult: result ? { success: result.success, output: result.output ?? '', error: result.error } : undefined,
      cwd: cwd ?? this.defaultCwd,
    });
  }

  // ─── Convenience: Context management ────────────────────────────────────

  /**
   * Convenience: run preCompact hooks.
   */
  async runPreCompact(hint?: string, cwd?: string): Promise<HookResult> {
    return this.run('preCompact', {
      hookType: 'preCompact',
      compactHint: hint,
      cwd: cwd ?? this.defaultCwd,
    });
  }

  /**
   * Convenience: run postCompact hooks.
   */
  async runPostCompact(summary?: string, cwd?: string): Promise<HookResult> {
    return this.run('postCompact', {
      hookType: 'postCompact',
      toolResult: summary ? { success: true, output: summary } : undefined,
      cwd: cwd ?? this.defaultCwd,
    });
  }

  // ─── Convenience: Task lifecycle ────────────────────────────────────────

  /**
   * Convenience: run taskCreated hooks.
   */
  async runTaskCreated(taskId: string, taskTitle?: string, cwd?: string): Promise<HookResult> {
    return this.run('taskCreated', {
      hookType: 'taskCreated',
      taskId,
      taskTitle,
      cwd: cwd ?? this.defaultCwd,
    });
  }

  /**
   * Convenience: run taskCompleted hooks.
   */
  async runTaskCompleted(taskId: string, result?: string, cwd?: string): Promise<HookResult> {
    return this.run('taskCompleted', {
      hookType: 'taskCompleted',
      taskId,
      toolResult: result ? { success: true, output: result } : undefined,
      cwd: cwd ?? this.defaultCwd,
    });
  }

  // ─── Convenience: File & config ─────────────────────────────────────────

  /**
   * Convenience: run fileChanged hooks.
   */
  async runFileChanged(filePath: string, cwd?: string): Promise<HookResult> {
    return this.run('fileChanged', {
      hookType: 'fileChanged',
      filePath,
      cwd: cwd ?? this.defaultCwd,
    });
  }

  // ─── Convenience: Worktree ──────────────────────────────────────────────

  /**
   * Convenience: run worktreeCreate hooks.
   */
  async runWorktreeCreate(worktreePath: string, cwd?: string): Promise<HookResult> {
    return this.run('worktreeCreate', {
      hookType: 'worktreeCreate',
      worktreePath,
      cwd: cwd ?? this.defaultCwd,
    });
  }

  /**
   * Convenience: run worktreeRemove hooks.
   */
  async runWorktreeRemove(worktreePath: string, cwd?: string): Promise<HookResult> {
    return this.run('worktreeRemove', {
      hookType: 'worktreeRemove',
      worktreePath,
      cwd: cwd ?? this.defaultCwd,
    });
  }

  // ─── Convenience: Notification ──────────────────────────────────────────

  /**
   * Convenience: run notification hooks.
   */
  async runNotification(message: string, cwd?: string): Promise<HookResult> {
    return this.run('notification', {
      hookType: 'notification',
      notificationMessage: message,
      cwd: cwd ?? this.defaultCwd,
    });
  }

  // ─── Private ────────────────────────────────────────────────────────────

  /**
   * Execute a single hook definition (shell command or JS function).
   */
  private async executeHook(def: HookDefinition, context: HookContext): Promise<HookResult> {
    if (def.fn) {
      return def.fn(context);
    }

    if (def.command) {
      return this.executeShellHook(def.command, def.timeout ?? 30_000, context);
    }

    // No command or function -- treat as a no-op
    return { allowed: true };
  }

  /**
   * Execute a shell-command hook.
   *
   * The command receives context as JSON via stdin (environment variable
   * HOOK_CONTEXT is also set for simpler consumption).
   *
   * Exit code 0 = allowed.
   * Exit code non-zero = blocked (if the hook is blocking).
   *
   * If stdout contains valid JSON with an `allowed` field, that is used.
   * Otherwise, exit code 0 means allowed, non-zero means blocked.
   */
  private async executeShellHook(
    command: string,
    timeout: number,
    context: HookContext,
  ): Promise<HookResult> {
    const contextJson = JSON.stringify(context);
    const cwd = context.cwd ?? this.defaultCwd;
    const env = {
      ...this.defaultEnv,
      HOOK_CONTEXT: contextJson,
      HOOK_TYPE: context.hookType,
      ...(context.env ?? {}),
    };

    this.logger.debug(`Executing shell hook: ${command}`);

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        env,
        timeout,
        maxBuffer: 1024 * 1024, // 1 MB
      });

      // Try to parse JSON from stdout
      const trimmed = stdout.trim();
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed) as Partial<HookResult>;
          return {
            allowed: parsed.allowed ?? true,
            message: parsed.message ?? (stderr.trim() || undefined),
            data: parsed.data,
            modifiedParams: parsed.modifiedParams,
          };
        } catch {
          // Not valid JSON -- fall through to exit-code logic
        }
      }

      // No JSON output -- use exit code
      return {
        allowed: true,
        message: stderr.trim() || trimmed || undefined,
      };
    } catch (err: unknown) {
      const execError = err as { stdout?: string; stderr?: string; message?: string };
      const stderr = execError.stderr ?? '';
      const stdout = execError.stdout ?? '';

      // Try to parse JSON from stdout even on failure
      const trimmed = (stdout || '').trim();
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed) as Partial<HookResult>;
          return {
            allowed: parsed.allowed ?? false,
            message: parsed.message || stderr.trim() || execError.message,
            data: parsed.data,
            modifiedParams: parsed.modifiedParams,
          };
        } catch {
          // Not valid JSON
        }
      }

      return {
        allowed: false,
        message: stderr.trim() || execError.message || `Hook command failed: ${command}`,
      };
    }
  }

  /**
   * Simple glob matching. Supports `*` (any chars) and `?` (single char).
   * Does NOT support `[...]` character classes or `**` recursive globs
   * to keep the implementation dependency-free.
   */
  private matchGlob(pattern: string, str: string): boolean {
    // Escape everything except * and ?
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');

    const regex = new RegExp(`^${regexStr}$`, 'i');
    return regex.test(str);
  }

  /**
   * Match a generic matcher expression against the hook context.
   *
   * Supports patterns like:
   *   - "Bash(rm *)"       -- matches toolName "Bash" with toolParams containing "rm ..."
   *   - "Write(src/**)"    -- matches toolName "Write" with filePath matching "src/**"
   *   - "Read(*.test.ts)"  -- matches toolName "Read" with filePath matching "*.test.ts"
   *   - "Bash"             -- matches toolName "Bash" (no argument constraint)
   *
   * If no toolName is present in the context, the match fails.
   */
  private matchExpression(matcher: string, context: HookContext): boolean {
    // Parse the matcher: "ToolName(pattern)" or just "ToolName"
    const match = /^(\w+)(?:\((.+)\))?$/.exec(matcher);
    if (!match) {
      this.logger.debug(`Invalid matcher expression: ${matcher}`);
      return false;
    }

    const [, toolPattern, argPattern] = match;

    // Must match the tool name
    if (!context.toolName || !this.matchGlob(toolPattern, context.toolName)) {
      return false;
    }

    // If there is an argument pattern, match it against filePath or toolParams
    if (argPattern) {
      // Try filePath first (common for file operations)
      if (context.filePath && this.matchGlob(argPattern, context.filePath)) {
        return true;
      }

      // Try matching against the first string-like param (e.g. Bash command)
      if (context.toolParams) {
        for (const value of Object.values(context.toolParams)) {
          if (typeof value === 'string' && this.matchGlob(argPattern, value)) {
            return true;
          }
        }
      }

      // No match on the argument pattern
      return false;
    }

    // Tool name matched and no argument constraint
    return true;
  }
}
