/**
 * core/project-config.ts
 *
 * Project configuration loader. Reads `ai-dev.json` from the project root
 * and merges it with sensible defaults. Uses only Node.js built-ins.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// ─── Tech Stack ──────────────────────────────────────────────────────────────

export interface TechStackConfig {
  language: string;
  framework?: string;
  frontend?: string;
  backend?: string;
  database?: string;
  packageManager?: string;
  other?: string[];
}

// ─── Coding Standards ────────────────────────────────────────────────────────

export interface CodingStandardsConfig {
  indentStyle?: 'space' | 'tab';
  indentSize?: number;
  semi?: boolean;
  singleQuotes?: boolean;
  trailingComma?: 'all' | 'es5' | 'none';
  maxLineLength?: number;
  namingConvention?: 'camelCase' | 'snake_case' | 'PascalCase' | 'kebab-case';
}

// ─── Agent Configuration ────────────────────────────────────────────────────

export interface AgentOverrideConfig {
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  systemPromptAppend?: string;
  allowedTools?: string[];
  blockedTools?: string[];
}

export interface AgentsConfig {
  orchestrator?: AgentOverrideConfig;
  developer?: AgentOverrideConfig;
  tester?: AgentOverrideConfig;
  reviewer?: AgentOverrideConfig;
  [key: string]: AgentOverrideConfig | undefined;
}

// ─── Hook Configuration (schema only; execution lives in hooks.ts) ───────────

export interface HookDefinition {
  /** Shell command to run */
  command?: string;
  /** Timeout in milliseconds (default 30 000) */
  timeout?: number;
  /** Whether the hook can block the action (default false) */
  blocking?: boolean;
}

export interface HooksConfig {
  sessionStart?: HookDefinition[];
  preToolUse?: HookDefinition[];
  postToolUse?: HookDefinition[];
  preCommit?: HookDefinition[];
  postTest?: HookDefinition[];
  onError?: HookDefinition[];
}

// ─── Task Executor Configuration ─────────────────────────────────────────────

export interface TaskExecutorConfig {
  maxConcurrency?: number;
  maxRetries?: number;
  retryBaseDelay?: number;       // ms – base for exponential backoff
  retryMaxDelay?: number;        // ms – cap for exponential backoff
  taskTimeout?: number;          // ms – per-task timeout
}

// ─── Full Project Config ─────────────────────────────────────────────────────

export interface ProjectConfig {
  /** Project name */
  name?: string;
  /** Project version */
  version?: string;
  /** Project description */
  description?: string;
  /** Technology stack */
  techStack: TechStackConfig;
  /** Coding standards */
  codingStandards: CodingStandardsConfig;
  /** Test framework to use */
  testFramework: string;
  /** Maximum retries for failed tasks */
  maxRetries: number;
  /** Hook definitions */
  hooks: HooksConfig;
  /** Per-agent overrides */
  agents: AgentsConfig;
  /** Task executor settings */
  taskExecutor: TaskExecutorConfig;
  /** Path to the config file (resolved after load) */
  configPath?: string;
  /** Path to the project root (resolved after load) */
  projectRoot?: string;
}

// ─── Raw JSON schema (what the user writes in ai-dev.json) ───────────────────

interface RawProjectConfig {
  name?: string;
  version?: string;
  description?: string;
  techStack?: Partial<TechStackConfig>;
  codingStandards?: Partial<CodingStandardsConfig>;
  testFramework?: string;
  maxRetries?: number;
  hooks?: Partial<HooksConfig>;
  agents?: AgentsConfig;
  taskExecutor?: Partial<TaskExecutorConfig>;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS: ProjectConfig = {
  techStack: {
    language: 'typescript',
    framework: undefined,
    frontend: undefined,
    backend: undefined,
    database: undefined,
    packageManager: 'npm',
    other: [],
  },
  codingStandards: {
    indentStyle: 'space',
    indentSize: 2,
    semi: true,
    singleQuotes: true,
    trailingComma: 'all',
    maxLineLength: 100,
    namingConvention: 'camelCase',
  },
  testFramework: 'vitest',
  maxRetries: 3,
  hooks: {},
  agents: {},
  taskExecutor: {
    maxConcurrency: 4,
    maxRetries: 3,
    retryBaseDelay: 1000,
    retryMaxDelay: 30000,
    taskTimeout: 300_000, // 5 minutes
  },
};

// ─── Deep merge helper ───────────────────────────────────────────────────────

function deepMerge<T extends object>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target } as Record<string, unknown>;

  for (const key of Object.keys(source) as Array<keyof T & string>) {
    const sourceVal = source[key];
    const targetVal = (target as Record<string, unknown>)[key];

    if (
      sourceVal !== null &&
      sourceVal !== undefined &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === 'object' &&
      targetVal !== null &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as object,
        sourceVal as object,
      );
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }

  return result as T;
}

// ─── Config Loader ───────────────────────────────────────────────────────────

const CONFIG_FILENAME = 'ai-dev.json';

export class ProjectConfigLoader {
  /**
   * Load project configuration from the given project root directory.
   *
   * Looks for `<projectRoot>/ai-dev.json`. If the file does not exist or
   * cannot be parsed, returns defaults with a warning logged to stderr.
   */
  static async load(projectRoot: string): Promise<ProjectConfig> {
    const configPath = join(projectRoot, CONFIG_FILENAME);
    let raw: RawProjectConfig = {};

    try {
      const contents = await readFile(configPath, 'utf-8');
      raw = JSON.parse(contents) as RawProjectConfig;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // No config file – use defaults silently
      } else if (code === 'EACCES') {
        process.stderr.write(
          `[project-config] Permission denied reading ${configPath}, using defaults\n`,
        );
      } else {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[project-config] Failed to parse ${configPath}: ${message}, using defaults\n`,
        );
      }
    }

    const config = deepMerge<ProjectConfig>(
      { ...DEFAULTS },
      {
        name: raw.name,
        version: raw.version,
        description: raw.description,
        techStack: raw.techStack
          ? deepMerge<TechStackConfig>({ ...DEFAULTS.techStack }, raw.techStack as Partial<TechStackConfig>)
          : undefined,
        codingStandards: raw.codingStandards
          ? deepMerge<CodingStandardsConfig>({ ...DEFAULTS.codingStandards }, raw.codingStandards as Partial<CodingStandardsConfig>)
          : undefined,
        testFramework: raw.testFramework,
        maxRetries: raw.maxRetries,
        hooks: raw.hooks ? deepMerge<HooksConfig>({ ...DEFAULTS.hooks }, raw.hooks as Partial<HooksConfig>) : undefined,
        agents: raw.agents ?? undefined,
        taskExecutor: raw.taskExecutor
          ? deepMerge<TaskExecutorConfig>({ ...DEFAULTS.taskExecutor }, raw.taskExecutor as Partial<TaskExecutorConfig>)
          : undefined,
      } as Partial<ProjectConfig>,
    );

    config.configPath = configPath;
    config.projectRoot = projectRoot;

    return config;
  }

  /**
   * Create a blank `ai-dev.json` file in the given project root with the
   * default values filled in. Useful for project scaffolding.
   */
  static async scaffold(projectRoot: string): Promise<string> {
    const configPath = join(projectRoot, CONFIG_FILENAME);
    const scaffold: RawProjectConfig = {
      name: '',
      version: '0.1.0',
      description: '',
      techStack: {
        language: 'typescript',
        packageManager: 'npm',
      },
      codingStandards: {
        indentStyle: 'space',
        indentSize: 2,
        semi: true,
        singleQuotes: true,
        trailingComma: 'all',
        maxLineLength: 100,
        namingConvention: 'camelCase',
      },
      testFramework: 'vitest',
      maxRetries: 3,
      hooks: {},
      agents: {},
      taskExecutor: {
        maxConcurrency: 4,
        maxRetries: 3,
        retryBaseDelay: 1000,
        retryMaxDelay: 30000,
        taskTimeout: 300_000,
      },
    };

    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(configPath, JSON.stringify(scaffold, null, 2) + '\n', 'utf-8');

    return configPath;
  }
}
