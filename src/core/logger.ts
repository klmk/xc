/**
 * core/logger.ts
 *
 * Structured logger with color-coded console output and file logging.
 * Uses only Node.js built-ins (no external dependencies).
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// ─── Log Levels ───────────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ─── ANSI Color Codes ────────────────────────────────────────────────────────

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
} as const;

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: COLORS.cyan,
  info: COLORS.green,
  warn: COLORS.yellow,
  error: COLORS.red,
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: ' INFO',
  warn: ' WARN',
  error: 'ERROR',
};

// ─── Log Entry ───────────────────────────────────────────────────────────────

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  agent: string;
  message: string;
  data?: unknown;
  correlationId?: string;
}

// ─── Logger Options ──────────────────────────────────────────────────────────

export interface LoggerOptions {
  /** Minimum log level to output (default: 'info') */
  minLevel?: LogLevel;
  /** Enable color output (default: true) */
  colorEnabled?: boolean;
  /** Directory for log files (default: null = no file logging) */
  logDir?: string | null;
  /** Include timestamp in console output (default: true) */
  showTimestamp?: boolean;
}

// ─── Logger Implementation ───────────────────────────────────────────────────

export class Logger {
  private minLevel: LogLevel;
  private colorEnabled: boolean;
  private logDir: string | null;
  private showTimestamp: boolean;
  private fileWriteQueue: Promise<void>;
  private initialized: boolean;

  constructor(options: LoggerOptions = {}) {
    this.minLevel = options.minLevel ?? 'info';
    this.colorEnabled = options.colorEnabled ?? true;
    this.logDir = options.logDir ?? null;
    this.showTimestamp = options.showTimestamp ?? true;
    this.fileWriteQueue = Promise.resolve();
    this.initialized = false;
  }

  /**
   * Initialize the logger. Ensures the log directory exists if file logging
   * is enabled. Must be called once before logging (idempotent).
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.logDir) {
      await mkdir(this.logDir, { recursive: true });
    }
    this.initialized = true;
  }

  /**
   * Create a child logger scoped to a specific agent / component name.
   */
  child(agent: string): ScopedLogger {
    return new ScopedLogger(this, agent);
  }

  /**
   * Log a debug-level message.
   */
  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }

  /**
   * Log an info-level message.
   */
  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  /**
   * Log a warning-level message.
   */
  warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }

  /**
   * Log an error-level message.
   */
  error(message: string, data?: unknown): void {
    this.log('error', message, data);
  }

  /**
   * Core logging method. Formats and emits the log entry.
   */
  log(level: LogLevel, message: string, data?: unknown, agent?: string): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minLevel]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      agent: agent ?? 'system',
      message,
      data,
    };

    this.writeToConsole(entry);
    this.writeToFile(entry);
  }

  /**
   * Format and write a log entry to stdout/stderr.
   */
  private writeToConsole(entry: LogEntry): void {
    const color = this.colorEnabled ? LEVEL_COLORS[entry.level] : '';
    const reset = this.colorEnabled ? COLORS.reset : '';
    const dim = this.colorEnabled ? COLORS.dim : '';
    const bold = this.colorEnabled ? COLORS.bold : '';

    const levelTag = `${color}${bold}${LEVEL_LABELS[entry.level]}${reset}`;
    const agentTag = `${dim}${entry.agent}${reset}`;
    const timestamp = this.showTimestamp
      ? `${dim}${entry.timestamp}${reset} `
      : '';

    const line = `${timestamp}${levelTag} ${agentTag}  ${entry.message}`;

    if (entry.level === 'error') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }

    // Print structured data on a separate line if present
    if (entry.data !== undefined) {
      const dataStr = typeof entry.data === 'string'
        ? entry.data
        : JSON.stringify(entry.data, null, 2);
      const prefix = this.showTimestamp
        ? `${dim}${' '.repeat(entry.timestamp.length)}${reset}       `
        : '       ';
      process.stdout.write(`${prefix}${dim}${dataStr}${reset}\n`);
    }
  }

  /**
   * Append a log entry to a daily log file. Writes are serialised through a
   * promise chain so that concurrent log calls do not interleave.
   */
  private writeToFile(entry: LogEntry): void {
    if (!this.logDir || !this.initialized) return;

    const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
    const logFilePath = join(this.logDir, `${date}.log`);
    const line = JSON.stringify(entry) + '\n';

    this.fileWriteQueue = this.fileWriteQueue
      .then(() => appendFile(logFilePath, line, 'utf-8'))
      .catch((err: NodeJS.ErrnoException) => {
        // Silently ignore file write errors so logging never crashes the app
        process.stderr.write(`[logger] Failed to write log file: ${err.message}\n`);
      });
  }

  /**
   * Flush pending file writes. Call before process exit.
   */
  async flush(): Promise<void> {
    await this.fileWriteQueue;
  }
}

// ─── Scoped Logger ───────────────────────────────────────────────────────────

/**
 * A logger pre-bound to an agent / component name.
 * Created via `logger.child('agentName')`.
 */
export class ScopedLogger {
  private logger: Logger;
  private agent: string;

  constructor(logger: Logger, agent: string) {
    this.logger = logger;
    this.agent = agent;
  }

  debug(message: string, data?: unknown): void {
    this.logger.log('debug', message, data, this.agent);
  }

  info(message: string, data?: unknown): void {
    this.logger.log('info', message, data, this.agent);
  }

  warn(message: string, data?: unknown): void {
    this.logger.log('warn', message, data, this.agent);
  }

  error(message: string, data?: unknown): void {
    this.logger.log('error', message, data, this.agent);
  }

  /**
   * Return the underlying root logger.
   */
  getRoot(): Logger {
    return this.logger;
  }
}

// ─── Default Singleton ───────────────────────────────────────────────────────

/**
 * Global default logger instance. Initialise with `defaultLogger.init()` at
 * application start if file logging is desired.
 */
export const defaultLogger = new Logger();
