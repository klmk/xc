/**
 * core/hooks.ts
 *
 * Hook system inspired by Claude Code. Hooks allow project-level customisation
 * of the agent lifecycle by running shell commands or JavaScript functions at
 * well-defined points:
 *
 *   - SessionStart   : when a development session begins
 *   - PreToolUse     : before a tool is invoked
 *   - PostToolUse    : after a tool has been invoked
 *   - PreCommit      : before a git commit
 *   - PostTest       : after tests have been run
 *   - OnError        : when an error occurs
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
  | 'sessionStart'
  | 'preToolUse'
  | 'postToolUse'
  | 'preCommit'
  | 'postTest'
  | 'onError';

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
  /** Error information (onError only) */
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
      'sessionStart',
      'preToolUse',
      'postToolUse',
      'preCommit',
      'postTest',
      'onError',
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
   */
  registerFromConfig(config: {
    sessionStart?: HookDefinition[];
    preToolUse?: HookDefinition[];
    postToolUse?: HookDefinition[];
    preCommit?: HookDefinition[];
    postTest?: HookDefinition[];
    onError?: HookDefinition[];
  }): void {
    const mapping: Array<[HookType, HookDefinition[] | undefined]> = [
      ['sessionStart', config.sessionStart],
      ['preToolUse', config.preToolUse],
      ['postToolUse', config.postToolUse],
      ['preCommit', config.preCommit],
      ['postTest', config.postTest],
      ['onError', config.onError],
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
   * Remove all hooks for a given type.
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

  /**
   * Convenience: run preCommit hooks.
   */
  async runPreCommit(cwd?: string): Promise<HookResult> {
    return this.run('preCommit', {
      hookType: 'preCommit',
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
    return this.run('postTest', {
      hookType: 'postTest',
      testResults,
      cwd: cwd ?? this.defaultCwd,
    });
  }

  /**
   * Convenience: run onError hooks.
   */
  async runOnError(
    error: Error,
    cwd?: string,
  ): Promise<HookResult> {
    return this.run('onError', {
      hookType: 'onError',
      error: {
        message: error.message,
        stack: error.stack,
      },
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

    // No command or function – treat as a no-op
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
          // Not valid JSON – fall through to exit-code logic
        }
      }

      // No JSON output – use exit code
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
}
