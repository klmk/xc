/**
 * core/task-executor.ts
 *
 * Parallel task execution engine with DAG-based dependency resolution,
 * configurable concurrency, retry logic with exponential backoff, and
 * result aggregation.
 *
 * Uses only Node.js built-ins.
 */

import type { Logger, ScopedLogger } from './logger.js';
import { defaultLogger } from './logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A task node in the execution graph.
 */
export interface TaskNode<T = unknown> {
  /** Unique task identifier */
  id: string;
  /** Human-readable title */
  title: string;
  /** IDs of tasks that must complete before this one can start */
  dependencies: string[];
  /** The function to execute for this task */
  execute: () => Promise<T>;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Status of a single task.
 */
export type TaskStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'skipped';

/**
 * Result of a single task execution.
 */
export interface TaskResult<T = unknown> {
  taskId: string;
  title: string;
  status: TaskStatus;
  result?: T;
  error?: string;
  duration: number;
  attempt: number;
}

/**
 * Overall execution result.
 */
export interface ExecutionResult<T = unknown> {
  /** Whether all tasks completed successfully */
  success: boolean;
  /** Individual task results keyed by task ID */
  results: Map<string, TaskResult<T>>;
  /** Total execution time in ms */
  totalDuration: number;
  /** Number of tasks that succeeded */
  succeeded: number;
  /** Number of tasks that failed */
  failed: number;
  /** Number of tasks that were skipped (due to dependency failure) */
  skipped: number;
}

/**
 * Configuration for the task executor.
 */
export interface TaskExecutorOptions {
  /** Maximum number of tasks running concurrently (default: 4) */
  maxConcurrency?: number;
  /** Maximum retry attempts per task (default: 3) */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  retryBaseDelay?: number;
  /** Maximum backoff delay in ms (default: 30 000) */
  retryMaxDelay?: number;
  /** Whether to stop executing remaining tasks when one fails (default: false) */
  failFast?: boolean;
  /** Per-task timeout in ms (default: 300 000 = 5 min) */
  taskTimeout?: number;
}

// ─── Internal tracking ───────────────────────────────────────────────────────

interface InternalTask<T = unknown> {
  node: TaskNode<T>;
  status: TaskStatus;
  result?: T;
  error?: string;
  duration: number;
  attempt: number;
  resolveDeps: number; // count of unresolved dependencies
}

// ─── Task Executor ───────────────────────────────────────────────────────────

export class TaskExecutor<T = unknown> {
  private maxConcurrency: number;
  private maxRetries: number;
  private retryBaseDelay: number;
  private retryMaxDelay: number;
  private failFast: boolean;
  private taskTimeout: number;
  private logger: ScopedLogger;

  constructor(options: TaskExecutorOptions = {}, logger?: Logger) {
    this.maxConcurrency = options.maxConcurrency ?? 4;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelay = options.retryBaseDelay ?? 1000;
    this.retryMaxDelay = options.retryMaxDelay ?? 30_000;
    this.failFast = options.failFast ?? false;
    this.taskTimeout = options.taskTimeout ?? 300_000;
    this.logger = (logger ?? defaultLogger).child('task-executor');
  }

  /**
   * Execute a set of tasks respecting their dependency graph (DAG).
   *
   * Tasks with no (or satisfied) dependencies are dispatched in parallel up
   * to `maxConcurrency`. When a task completes, its dependents are checked
   * and dispatched if all their dependencies are now satisfied.
   *
   * Failed tasks are retried with exponential backoff up to `maxRetries`.
   * If a task ultimately fails, all tasks that depend on it (transitively)
   * are marked as skipped -- unless `failFast` is set, in which case the
   * entire execution aborts immediately.
   */
  async execute(tasks: TaskNode<T>[]): Promise<ExecutionResult<T>> {
    const startTime = Date.now();

    // Build internal task map and dependency graph
    const taskMap = new Map<string, InternalTask<T>>();
    const dependents = new Map<string, Set<string>>(); // taskId -> set of tasks that depend on it

    for (const node of tasks) {
      const deps = node.dependencies.filter((d) => {
        // Validate that dependency exists
        const exists = tasks.some((t) => t.id === d);
        if (!exists) {
          this.logger.warn(`Task "${node.id}" has unknown dependency "${d}", ignoring`);
        }
        return exists;
      });

      taskMap.set(node.id, {
        node: { ...node, dependencies: deps },
        status: 'pending',
        duration: 0,
        attempt: 0,
        resolveDeps: deps.length,
      });

      for (const depId of deps) {
        let set = dependents.get(depId);
        if (!set) {
          set = new Set();
          dependents.set(depId, set);
        }
        set.add(node.id);
      }
    }

    // Detect cycles using DFS
    this.detectCycles(taskMap);

    const results = new Map<string, TaskResult<T>>();
    let failedCount = 0;
    let skippedCount = 0;
    let succeededCount = 0;
    let aborted = false;

    // Active concurrency tracking
    let activeCount = 0;
    const waitQueue: Array<() => void> = [];

    const acquireSlot = (): Promise<void> => {
      if (activeCount < this.maxConcurrency && !aborted) {
        activeCount++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waitQueue.push(() => {
          if (aborted) {
            // Reject by resolving with no-op; the caller checks `aborted`
            resolve();
            return;
          }
          activeCount++;
          resolve();
        });
      });
    };

    const releaseSlot = (): void => {
      activeCount--;
      const next = waitQueue.shift();
      if (next) {
        next();
      }
    };

    // Mark tasks that are immediately ready (no dependencies)
    for (const [, task] of taskMap) {
      if (task.resolveDeps === 0) {
        task.status = 'ready';
      }
    }

    // Process all tasks
    const processReadyTasks = async (): Promise<void> => {
      const readyTasks = Array.from(taskMap.values()).filter(
        (t) => t.status === 'ready',
      );

      const dispatchPromises = readyTasks.map(async (task) => {
        if (aborted) return;

        await acquireSlot();
        if (aborted) {
          releaseSlot();
          return;
        }

        task.status = 'running';
        this.logger.info(`Executing task: ${task.node.title}`, {
          taskId: task.node.id,
          attempt: task.attempt + 1,
        });

        const taskStart = Date.now();
        try {
          // Execute with timeout
          const result = await this.withTimeout(
            task.node.execute(),
            this.taskTimeout,
            task.node.title,
          );

          task.status = 'completed';
          task.result = result;
          task.duration = Date.now() - taskStart;
          task.attempt++;

          results.set(task.node.id, {
            taskId: task.node.id,
            title: task.node.title,
            status: 'completed',
            result,
            duration: task.duration,
            attempt: task.attempt,
          });

          succeededCount++;
          this.logger.info(`Task completed: ${task.node.title}`, {
            taskId: task.node.id,
            duration: task.duration,
          });

          // Resolve dependents
          const deps = dependents.get(task.node.id);
          if (deps) {
            for (const depId of deps) {
              const depTask = taskMap.get(depId);
              if (depTask && depTask.status === 'pending') {
                depTask.resolveDeps--;
                if (depTask.resolveDeps === 0) {
                  depTask.status = 'ready';
                }
              }
            }
          }
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          task.duration = Date.now() - taskStart;
          task.attempt++;
          task.error = errorMessage;

          // Retry logic
          if (task.attempt < this.maxRetries && !aborted) {
            const delay = this.calculateBackoff(task.attempt);
            this.logger.warn(
              `Task failed, retrying in ${delay}ms (attempt ${task.attempt}/${this.maxRetries}): ${task.node.title}`,
              { taskId: task.node.id, error: errorMessage },
            );

            await this.sleep(delay);

            if (!aborted) {
              task.status = 'ready'; // Re-queue for retry
            }
          } else {
            // Final failure
            task.status = 'failed';
            failedCount++;

            results.set(task.node.id, {
              taskId: task.node.id,
              title: task.node.title,
              status: 'failed',
              error: errorMessage,
              duration: task.duration,
              attempt: task.attempt,
            });

            this.logger.error(`Task failed permanently: ${task.node.title}`, {
              taskId: task.node.id,
              error: errorMessage,
              attempts: task.attempt,
            });

            // Skip all transitive dependents
            this.skipDependents(task.node.id, taskMap, dependents, results);
            skippedCount = this.countSkipped(taskMap);

            if (this.failFast) {
              aborted = true;
              // Drain the wait queue
              while (waitQueue.length > 0) {
                waitQueue.shift()!();
              }
            }
          }
        } finally {
          releaseSlot();
        }
      });

      await Promise.all(dispatchPromises);
    };

    // Main execution loop: keep processing until no more ready tasks
    while (!aborted) {
      const hasReady = Array.from(taskMap.values()).some(
        (t) => t.status === 'ready' || t.status === 'running',
      );

      if (!hasReady) break;

      await processReadyTasks();
    }

    // If aborted due to failFast, mark remaining pending tasks as skipped
    if (aborted) {
      for (const [, task] of taskMap) {
        if (task.status === 'pending' || task.status === 'ready') {
          task.status = 'skipped';
          results.set(task.node.id, {
            taskId: task.node.id,
            title: task.node.title,
            status: 'skipped',
            duration: 0,
            attempt: 0,
          });
        }
      }
      skippedCount = Array.from(taskMap.values()).filter(
        (t) => t.status === 'skipped',
      ).length;
    }

    const totalDuration = Date.now() - startTime;

    this.logger.info('Task execution complete', {
      total: tasks.length,
      succeeded: succeededCount,
      failed: failedCount,
      skipped: skippedCount,
      duration: totalDuration,
    });

    return {
      success: failedCount === 0 && skippedCount === 0,
      results,
      totalDuration,
      succeeded: succeededCount,
      failed: failedCount,
      skipped: skippedCount,
    };
  }

  /**
   * Execute tasks in simple parallel (no dependency tracking).
   * All tasks are dispatched immediately up to maxConcurrency.
   */
  async executeParallel(tasks: TaskNode<T>[]): Promise<ExecutionResult<T>> {
    // Convert to no-dependency tasks
    const noDepsTasks = tasks.map((t) => ({
      ...t,
      dependencies: [] as string[],
    }));
    return this.execute(noDepsTasks);
  }

  /**
   * Execute tasks sequentially (one at a time).
   */
  async executeSequential(tasks: TaskNode<T>[]): Promise<ExecutionResult<T>> {
    const executor = new TaskExecutor<T>(
      { ...this.getOptions(), maxConcurrency: 1 },
      this.logger.getRoot(),
    );
    return executor.execute(tasks);
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  private getOptions(): TaskExecutorOptions {
    return {
      maxConcurrency: this.maxConcurrency,
      maxRetries: this.maxRetries,
      retryBaseDelay: this.retryBaseDelay,
      retryMaxDelay: this.retryMaxDelay,
      failFast: this.failFast,
      taskTimeout: this.taskTimeout,
    };
  }

  /**
   * Calculate exponential backoff delay with jitter.
   */
  private calculateBackoff(attempt: number): number {
    const base = Math.min(
      this.retryBaseDelay * Math.pow(2, attempt - 1),
      this.retryMaxDelay,
    );
    // Add jitter: +/- 25%
    const jitter = base * 0.25;
    const jittered = base + (Math.random() * 2 - 1) * jitter;
    return Math.max(0, Math.round(jittered));
  }

  /**
   * Wrap a promise with a timeout.
   */
  private withTimeout<R>(promise: Promise<R>, ms: number, label: string): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Task timeout after ${ms}ms: ${label}`));
      }, ms);

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /**
   * Recursively skip all tasks that transitively depend on a failed task.
   */
  private skipDependents<T>(
    failedTaskId: string,
    taskMap: Map<string, InternalTask<T>>,
    dependents: Map<string, Set<string>>,
    results: Map<string, TaskResult<T>>,
  ): void {
    const deps = dependents.get(failedTaskId);
    if (!deps) return;

    for (const depId of deps) {
      const depTask = taskMap.get(depId);
      if (depTask && (depTask.status === 'pending' || depTask.status === 'ready')) {
        depTask.status = 'skipped';
        results.set(depId, {
          taskId: depId,
          title: depTask.node.title,
          status: 'skipped',
          duration: 0,
          attempt: 0,
          error: `Skipped due to failed dependency: ${failedTaskId}`,
        });

        // Recursively skip dependents of this skipped task
        this.skipDependents(depId, taskMap, dependents, results);
      }
    }
  }

  /**
   * Count tasks with 'skipped' status.
   */
  private countSkipped<T>(taskMap: Map<string, InternalTask<T>>): number {
    let count = 0;
    for (const [, task] of taskMap) {
      if (task.status === 'skipped') count++;
    }
    return count;
  }

  /**
   * Detect cycles in the dependency graph using DFS.
   * Throws an error if a cycle is found.
   */
  private detectCycles<T>(taskMap: Map<string, InternalTask<T>>): void {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (taskId: string): boolean => {
      visited.add(taskId);
      recursionStack.add(taskId);

      const task = taskMap.get(taskId);
      if (!task) return false;

      for (const depId of task.node.dependencies) {
        if (!visited.has(depId)) {
          if (dfs(depId)) return true;
        } else if (recursionStack.has(depId)) {
          throw new Error(
            `Cycle detected in task dependency graph involving tasks: ${taskId} -> ${depId}`,
          );
        }
      }

      recursionStack.delete(taskId);
      return false;
    };

    for (const taskId of taskMap.keys()) {
      if (!visited.has(taskId)) {
        if (dfs(taskId)) {
          throw new Error('Cycle detected in task dependency graph');
        }
      }
    }
  }

  /**
   * Sleep for the given number of milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
