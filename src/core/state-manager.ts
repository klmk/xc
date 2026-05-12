/**
 * core/state-manager.ts
 *
 * Lightweight state manager with in-memory state, JSON file persistence,
 * snapshot/rollback support, and change-event emission.
 * Uses only Node.js built-ins.
 */

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

// ─── Types ───────────────────────────────────────────────────────────────────

export type StateChangeEvent = {
  key: string;
  oldValue: unknown;
  newValue: unknown;
  timestamp: string;
};

export type SnapshotMeta = {
  id: string;
  label: string;
  createdAt: string;
  stateFile: string;
};

export interface StateManagerOptions {
  /** Directory where state files are stored (default: '.ai-dev/state') */
  stateDir?: string;
  /** Base directory for the project (used to resolve stateDir) */
  projectRoot?: string;
  /** Auto-persist to disk on every set (default: true) */
  autoPersist?: boolean;
  /** Debounce interval for auto-persist in ms (default: 100) */
  persistDebounce?: number;
}

// ─── State Manager ───────────────────────────────────────────────────────────

export class StateManager extends EventEmitter {
  private state: Record<string, unknown>;
  private stateDir: string;
  private autoPersist: boolean;
  private persistDebounce: number;
  private persistTimer: ReturnType<typeof setTimeout> | null;
  private snapshotsDir: string;
  private dirty: boolean;
  private persistPromise: Promise<void> | null;
  private initialized: boolean;

  constructor(options: StateManagerOptions = {}) {
    super();
    this.state = {};
    this.stateDir = options.stateDir ?? '.ai-dev/state';
    this.autoPersist = options.autoPersist ?? true;
    this.persistDebounce = options.persistDebounce ?? 100;
    this.persistTimer = null;
    this.snapshotsDir = join(this.stateDir, 'snapshots');
    this.dirty = false;
    this.persistPromise = null;
    this.initialized = false;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Initialize the state manager. Creates directories and loads existing
   * state from disk if available.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    await mkdir(this.stateDir, { recursive: true });
    await mkdir(this.snapshotsDir, { recursive: true });

    await this.loadFromDisk();
    this.initialized = true;
  }

  /**
   * Flush any pending persistence and clean up timers.
   */
  async shutdown(): Promise<void> {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persistNow();
    this.removeAllListeners();
    this.initialized = false;
  }

  // ─── Read Operations ────────────────────────────────────────────────────

  /**
   * Get a value by key. Returns `undefined` if the key does not exist.
   */
  get<T = unknown>(key: string): T | undefined {
    return this.state[key] as T | undefined;
  }

  /**
   * Get a value by key, returning the provided default if the key is missing.
   */
  getOrDefault<T>(key: string, defaultValue: T): T {
    const val = this.state[key];
    return val !== undefined ? (val as T) : defaultValue;
  }

  /**
   * Check whether a key exists in state.
   */
  has(key: string): boolean {
    return key in this.state;
  }

  /**
   * Return a shallow copy of the entire state object.
   */
  getAll(): Record<string, unknown> {
    return { ...this.state };
  }

  /**
   * Return the list of top-level keys currently stored.
   */
  keys(): string[] {
    return Object.keys(this.state);
  }

  // ─── Write Operations ───────────────────────────────────────────────────

  /**
   * Set a key-value pair. Emits a 'change' event and schedules persistence.
   */
  set(key: string, value: unknown): void {
    const oldValue = this.state[key];
    this.state[key] = value;
    this.dirty = true;

    const event: StateChangeEvent = {
      key,
      oldValue,
      newValue: value,
      timestamp: new Date().toISOString(),
    };
    this.emit('change', event);
    this.emit(`change:${key}`, event);

    if (this.autoPersist) {
      this.schedulePersist();
    }
  }

  /**
   * Delete a key from state. Emits a 'change' event.
   */
  delete(key: string): boolean {
    if (!(key in this.state)) return false;

    const oldValue = this.state[key];
    delete this.state[key];
    this.dirty = true;

    const event: StateChangeEvent = {
      key,
      oldValue,
      newValue: undefined,
      timestamp: new Date().toISOString(),
    };
    this.emit('change', event);
    this.emit(`change:${key}`, event);

    if (this.autoPersist) {
      this.schedulePersist();
    }

    return true;
  }

  /**
   * Merge a partial object into state. Existing keys not in `patch` are
   * left untouched.
   */
  merge(patch: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(patch)) {
      this.set(key, value);
    }
  }

  /**
   * Check whether the state has unsaved changes.
   */
  isDirty(): boolean {
    return this.dirty;
  }

  /**
   * Remove all keys from state.
   */
  clear(): void {
    const oldState = { ...this.state };
    this.state = {};
    this.dirty = true;

    for (const key of Object.keys(oldState)) {
      const event: StateChangeEvent = {
        key,
        oldValue: oldState[key],
        newValue: undefined,
        timestamp: new Date().toISOString(),
      };
      this.emit('change', event);
      this.emit(`change:${key}`, event);
    }

    if (this.autoPersist) {
      this.schedulePersist();
    }
  }

  // ─── Snapshots ──────────────────────────────────────────────────────────

  /**
   * Create a named snapshot of the current state. Snapshots are stored as
   * separate JSON files and can be rolled back to at any time.
   */
  async createSnapshot(label: string): Promise<string> {
    await this.persistNow();

    const id = randomUUID();
    const stateFile = join(this.snapshotsDir, `${id}.json`);
    const metaFile = join(this.snapshotsDir, `${id}.meta.json`);

    const meta: SnapshotMeta = {
      id,
      label,
      createdAt: new Date().toISOString(),
      stateFile,
    };

    // Write the state file
    const stateJson = JSON.stringify(this.state, null, 2);
    await writeFile(stateFile, stateJson, 'utf-8');

    // Write the metadata file
    await writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf-8');

    this.emit('snapshot', meta);
    return id;
  }

  /**
   * List all available snapshots.
   */
  async listSnapshots(): Promise<SnapshotMeta[]> {
    const { readdir } = await import('node:fs/promises');
    let files: string[];
    try {
      files = await readdir(this.snapshotsDir);
    } catch {
      return [];
    }

    const metas: SnapshotMeta[] = [];
    for (const file of files) {
      if (!file.endsWith('.meta.json')) continue;
      try {
        const contents = await readFile(join(this.snapshotsDir, file), 'utf-8');
        metas.push(JSON.parse(contents) as SnapshotMeta);
      } catch {
        // Skip corrupt metadata files
      }
    }

    metas.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return metas;
  }

  /**
   * Roll back state to a previously created snapshot.
   */
  async rollback(snapshotId: string): Promise<void> {
    const stateFile = join(this.snapshotsDir, `${snapshotId}.json`);

    let contents: string;
    try {
      contents = await readFile(stateFile, 'utf-8');
    } catch {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }

    const restoredState = JSON.parse(contents) as Record<string, unknown>;
    const oldState = { ...this.state };

    this.state = restoredState;
    this.dirty = true;

    for (const key of Object.keys(this.state)) {
      const event: StateChangeEvent = {
        key,
        oldValue: oldState[key],
        newValue: this.state[key],
        timestamp: new Date().toISOString(),
      };
      this.emit('change', event);
      this.emit(`change:${key}`, event);
    }

    // Also emit events for keys that were removed
    for (const key of Object.keys(oldState)) {
      if (!(key in this.state)) {
        const event: StateChangeEvent = {
          key,
          oldValue: oldState[key],
          newValue: undefined,
          timestamp: new Date().toISOString(),
        };
        this.emit('change', event);
        this.emit(`change:${key}`, event);
      }
    }

    this.emit('rollback', { snapshotId, timestamp: new Date().toISOString() });

    if (this.autoPersist) {
      await this.persistNow();
    }
  }

  /**
   * Delete a snapshot by ID.
   */
  async deleteSnapshot(snapshotId: string): Promise<void> {
    const stateFile = join(this.snapshotsDir, `${snapshotId}.json`);
    const metaFile = join(this.snapshotsDir, `${snapshotId}.meta.json`);

    for (const file of [stateFile, metaFile]) {
      try {
        await unlink(file);
      } catch {
        // Ignore if file doesn't exist
      }
    }

    this.emit('snapshot-deleted', { snapshotId });
  }

  // ─── Persistence ────────────────────────────────────────────────────────

  /**
   * Save the current state to disk immediately.
   */
  async persistNow(): Promise<void> {
    // Chain persistence calls so they don't overlap
    if (this.persistPromise) {
      await this.persistPromise;
    }

    this.persistPromise = this.doPersist();
    try {
      await this.persistPromise;
    } finally {
      this.persistPromise = null;
    }
  }

  private async doPersist(): Promise<void> {
    const filePath = join(this.stateDir, 'state.json');
    const tmpPath = join(this.stateDir, 'state.json.tmp');

    const json = JSON.stringify(this.state, null, 2);

    // Write to a temp file first, then atomically rename
    await writeFile(tmpPath, json, 'utf-8');
    await rename(tmpPath, filePath);

    this.dirty = false;
  }

  private async loadFromDisk(): Promise<void> {
    const filePath = join(this.stateDir, 'state.json');

    try {
      const contents = await readFile(filePath, 'utf-8');
      this.state = JSON.parse(contents) as Record<string, unknown>;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // No state file yet – start with empty state
        this.state = {};
      } else {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[state-manager] Failed to load state: ${message}. Starting with empty state.\n`,
        );
        this.state = {};
      }
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow().catch((err: Error) => {
        process.stderr.write(
          `[state-manager] Persist failed: ${err.message}\n`,
        );
      });
    }, this.persistDebounce);
  }
}
