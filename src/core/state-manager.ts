/**
 * core/state-manager.ts
 *
 * Lightweight state manager with in-memory state, JSON file persistence,
 * snapshot/rollback support, and change-event emission.
 * Includes full project snapshot engine inspired by Replit's snapshot engine.
 * Uses only Node.js built-ins.
 */

import { readFile, writeFile, mkdir, rename, unlink, copyFile, readdir, stat } from 'node:fs/promises';
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

export interface FullSnapshotMeta extends SnapshotMeta {
  id: string;
  label: string;
  createdAt: string;
  stateFile: string;
  // New fields
  agentContexts?: Record<string, {
    agentId: string;
    agentName: string;
    historySize: number;
    status: string;
    activeTaskId?: string;
  }>;
  gitCommitHash?: string;
  gitBranch?: string;
  filesChanged?: string[];
  triggerReason: 'auto' | 'manual' | 'pre_edit' | 'post_test' | 'milestone' | 'error_recovery';
  projectMetadata?: Record<string, unknown>;
}

export interface AutoSnapshotRule {
  trigger: 'on_change' | 'on_interval' | 'on_task_complete' | 'on_error';
  labelPrefix?: string;
  maxSnapshots?: number; // Auto-cleanup old snapshots beyond this limit
  intervalMs?: number;   // For on_interval trigger
}

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

  // Auto-snapshot fields
  private autoSnapshotRules: AutoSnapshotRule[];
  private autoSnapshotsEnabled: boolean;
  private changeCounter: number;
  private autoSnapshotIntervalTimer: ReturnType<typeof setInterval> | null;
  private readonly ON_CHANGE_DEFAULT_THRESHOLD = 10;

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

    // Auto-snapshot initialization
    this.autoSnapshotRules = [];
    this.autoSnapshotsEnabled = false;
    this.changeCounter = 0;
    this.autoSnapshotIntervalTimer = null;
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
    this.disableAutoSnapshots();
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
   * When auto-snapshots are enabled, checks if any auto-snapshot rule triggers.
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

    // Auto-snapshot: on_change trigger
    if (this.autoSnapshotsEnabled) {
      this.changeCounter++;
      this.evaluateAutoSnapshotTriggers('on_change');
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
   * Create a full snapshot with extended metadata. Internally delegates to
   * createSnapshot but writes additional FullSnapshotMeta information.
   */
  async createFullSnapshot(options: {
    label: string;
    triggerReason: FullSnapshotMeta['triggerReason'];
    agentContexts?: FullSnapshotMeta['agentContexts'];
    gitCommitHash?: string;
    gitBranch?: string;
    filesChanged?: string[];
    projectMetadata?: Record<string, unknown>;
  }): Promise<string> {
    // Delegate to the existing createSnapshot for the core state capture
    const id = await this.createSnapshot(options.label);

    // Build the full metadata by extending what createSnapshot already wrote
    const metaFile = join(this.snapshotsDir, `${id}.meta.json`);
    const stateFile = join(this.snapshotsDir, `${id}.json`);

    // Read the existing meta to get the base fields
    const existingMeta = JSON.parse(await readFile(metaFile, 'utf-8')) as SnapshotMeta;

    const fullMeta: FullSnapshotMeta = {
      ...existingMeta,
      stateFile,
      triggerReason: options.triggerReason,
    };

    if (options.agentContexts !== undefined) {
      fullMeta.agentContexts = options.agentContexts;
    }
    if (options.gitCommitHash !== undefined) {
      fullMeta.gitCommitHash = options.gitCommitHash;
    }
    if (options.gitBranch !== undefined) {
      fullMeta.gitBranch = options.gitBranch;
    }
    if (options.filesChanged !== undefined) {
      fullMeta.filesChanged = options.filesChanged;
    }
    if (options.projectMetadata !== undefined) {
      fullMeta.projectMetadata = options.projectMetadata;
    }

    // Overwrite the metadata file with the full version
    await writeFile(metaFile, JSON.stringify(fullMeta, null, 2), 'utf-8');

    this.emit('full-snapshot', fullMeta);
    return id;
  }

  /**
   * Get detailed metadata for a specific snapshot.
   * Returns null if the snapshot does not exist.
   */
  async getSnapshot(id: string): Promise<FullSnapshotMeta | null> {
    const metaFile = join(this.snapshotsDir, `${id}.meta.json`);

    try {
      const contents = await readFile(metaFile, 'utf-8');
      const parsed = JSON.parse(contents) as SnapshotMeta;

      // If it already has triggerReason, treat it as a FullSnapshotMeta
      if ('triggerReason' in parsed) {
        return parsed as FullSnapshotMeta;
      }

      // Otherwise, wrap the basic meta into a FullSnapshotMeta with a default triggerReason
      const fullMeta: FullSnapshotMeta = {
        ...parsed,
        triggerReason: 'manual',
      };
      return fullMeta;
    } catch {
      return null;
    }
  }

  /**
   * Get the most recent snapshot. Returns null if no snapshots exist.
   */
  async getLatestSnapshot(): Promise<FullSnapshotMeta | null> {
    const snapshots = await this.listSnapshots();
    if (snapshots.length === 0) return null;

    // listSnapshots returns them sorted by createdAt ascending, so take the last
    const latest = snapshots[snapshots.length - 1];
    return this.getSnapshot(latest.id);
  }

  /**
   * Delete oldest snapshots beyond maxKeep. Returns the count of deleted snapshots.
   */
  async cleanupOldSnapshots(maxKeep: number): Promise<number> {
    const snapshots = await this.listSnapshots();
    if (snapshots.length <= maxKeep) return 0;

    const toDelete = snapshots.slice(0, snapshots.length - maxKeep);
    let deletedCount = 0;

    for (const snapshot of toDelete) {
      try {
        await this.deleteSnapshot(snapshot.id);
        deletedCount++;
      } catch {
        // Skip snapshots that fail to delete
      }
    }

    return deletedCount;
  }

  /**
   * Compare two snapshots' state files to show what keys changed.
   * Returns null if either snapshot does not exist.
   */
  async getSnapshotDiff(
    id1: string,
    id2: string,
  ): Promise<{ added: string[]; removed: string[]; changed: string[] } | null> {
    const stateFile1 = join(this.snapshotsDir, `${id1}.json`);
    const stateFile2 = join(this.snapshotsDir, `${id2}.json`);

    let contents1: string;
    let contents2: string;

    try {
      contents1 = await readFile(stateFile1, 'utf-8');
    } catch {
      return null;
    }

    try {
      contents2 = await readFile(stateFile2, 'utf-8');
    } catch {
      return null;
    }

    const state1 = JSON.parse(contents1) as Record<string, unknown>;
    const state2 = JSON.parse(contents2) as Record<string, unknown>;

    const keys1 = new Set(Object.keys(state1));
    const keys2 = new Set(Object.keys(state2));

    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];

    // Keys in state2 but not in state1 are added
    for (const key of keys2) {
      if (!keys1.has(key)) {
        added.push(key);
      }
    }

    // Keys in state1 but not in state2 are removed
    for (const key of keys1) {
      if (!keys2.has(key)) {
        removed.push(key);
      }
    }

    // Keys in both but with different values are changed
    for (const key of keys1) {
      if (keys2.has(key)) {
        if (JSON.stringify(state1[key]) !== JSON.stringify(state2[key])) {
          changed.push(key);
        }
      }
    }

    return { added, removed, changed };
  }

  /**
   * List all available snapshots.
   */
  async listSnapshots(): Promise<SnapshotMeta[]> {
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

  // ─── Auto-Snapshot Configuration ────────────────────────────────────────

  /**
   * Set the auto-snapshot rules. Replaces any previously configured rules.
   */
  setAutoSnapshotRules(rules: AutoSnapshotRule[]): void {
    this.autoSnapshotRules = rules;

    // If auto-snapshots are already enabled, restart the interval timer
    // to pick up any new on_interval rules
    if (this.autoSnapshotsEnabled) {
      this.stopIntervalTimer();
      this.startIntervalTimer();
    }
  }

  /**
   * Enable auto-snapshots based on the configured rules.
   */
  enableAutoSnapshots(): void {
    this.autoSnapshotsEnabled = true;
    this.changeCounter = 0;
    this.startIntervalTimer();
  }

  /**
   * Disable auto-snapshots. Stops any interval timers.
   */
  disableAutoSnapshots(): void {
    this.autoSnapshotsEnabled = false;
    this.stopIntervalTimer();
  }

  /**
   * Signal that a task has completed. Triggers any on_task_complete rules.
   */
  async notifyTaskComplete(taskLabel?: string): Promise<void> {
    if (!this.autoSnapshotsEnabled) return;
    await this.evaluateAutoSnapshotTriggers('on_task_complete', taskLabel);
  }

  /**
   * Signal that an error has occurred. Triggers any on_error rules.
   */
  async notifyError(errorLabel?: string): Promise<void> {
    if (!this.autoSnapshotsEnabled) return;
    await this.evaluateAutoSnapshotTriggers('on_error', errorLabel);
  }

  // ─── Snapshot Export / Import ───────────────────────────────────────────

  /**
   * Export a snapshot to a given directory. Copies the state file and metadata
   * file into the target directory.
   */
  async exportSnapshot(id: string, outputPath: string): Promise<void> {
    const stateFile = join(this.snapshotsDir, `${id}.json`);
    const metaFile = join(this.snapshotsDir, `${id}.meta.json`);

    // Verify the snapshot exists
    try {
      await stat(metaFile);
    } catch {
      throw new Error(`Snapshot not found: ${id}`);
    }

    await mkdir(outputPath, { recursive: true });

    const exportedStateFile = join(outputPath, `${id}.json`);
    const exportedMetaFile = join(outputPath, `${id}.meta.json`);

    await copyFile(stateFile, exportedStateFile);
    await copyFile(metaFile, exportedMetaFile);
  }

  /**
   * Import a snapshot from a directory. Copies the state file and metadata
   * file into the snapshots directory. Returns the new snapshot ID.
   */
  async importSnapshot(sourcePath: string): Promise<string> {
    // List files in the source directory to find snapshot files
    let files: string[];
    try {
      files = await readdir(sourcePath);
    } catch {
      throw new Error(`Cannot read source directory: ${sourcePath}`);
    }

    // Find the meta file to determine the snapshot ID
    const metaFileEntry = files.find((f) => f.endsWith('.meta.json'));
    if (!metaFileEntry) {
      throw new Error(`No snapshot metadata file found in: ${sourcePath}`);
    }

    const stateFileEntry = files.find((f) => f.endsWith('.json') && f !== metaFileEntry);
    if (!stateFileEntry) {
      throw new Error(`No snapshot state file found in: ${sourcePath}`);
    }

    // Read the existing metadata to extract the original ID
    const sourceMetaPath = join(sourcePath, metaFileEntry);
    const sourceMeta = JSON.parse(await readFile(sourceMetaPath, 'utf-8')) as SnapshotMeta;

    // Generate a new ID to avoid collisions
    const newId = randomUUID();
    const newStateFile = join(this.snapshotsDir, `${newId}.json`);
    const newMetaFile = join(this.snapshotsDir, `${newId}.meta.json`);

    // Copy the state file
    const sourceStatePath = join(sourcePath, stateFileEntry);
    await copyFile(sourceStatePath, newStateFile);

    // Update the metadata with the new ID and paths, then write it
    const importedMeta: SnapshotMeta = {
      ...sourceMeta,
      id: newId,
      stateFile: newStateFile,
      label: `${sourceMeta.label} (imported)`,
      createdAt: new Date().toISOString(),
    };

    await writeFile(newMetaFile, JSON.stringify(importedMeta, null, 2), 'utf-8');

    this.emit('snapshot-imported', { originalId: sourceMeta.id, newId });
    return newId;
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

  // ─── Auto-Snapshot Internal ────────────────────────────────────────────

  /**
   * Evaluate auto-snapshot rules for a given trigger type.
   * Fires the snapshot if conditions are met.
   */
  private async evaluateAutoSnapshotTriggers(
    trigger: AutoSnapshotRule['trigger'],
    extraLabel?: string,
  ): Promise<void> {
    const matchingRules = this.autoSnapshotRules.filter((r) => r.trigger === trigger);

    for (const rule of matchingRules) {
      let shouldFire = false;

      switch (trigger) {
        case 'on_change': {
          // Fire every ON_CHANGE_DEFAULT_THRESHOLD changes
          if (this.changeCounter >= this.ON_CHANGE_DEFAULT_THRESHOLD) {
            shouldFire = true;
            this.changeCounter = 0;
          }
          break;
        }
        case 'on_interval': {
          // Handled by the interval timer; no immediate action here
          break;
        }
        case 'on_task_complete':
        case 'on_error': {
          // These fire immediately when signaled
          shouldFire = true;
          break;
        }
      }

      if (!shouldFire) continue;

      // Build the label
      const prefix = rule.labelPrefix ?? 'auto';
      const label = extraLabel
        ? `${prefix}: ${extraLabel} (${new Date().toISOString()})`
        : `${prefix}: ${trigger} (${new Date().toISOString()})`;

      // Create the full snapshot
      const id = await this.createFullSnapshot({
        label,
        triggerReason: trigger === 'on_error' ? 'error_recovery' : 'auto',
      });

      // Auto-cleanup if maxSnapshots is configured
      if (rule.maxSnapshots !== undefined && rule.maxSnapshots > 0) {
        await this.cleanupOldSnapshots(rule.maxSnapshots);
      }

      this.emit('auto-snapshot', { id, trigger, rule });
    }
  }

  /**
   * Start the interval timer for any on_interval rules.
   */
  private startIntervalTimer(): void {
    this.stopIntervalTimer();

    const intervalRules = this.autoSnapshotRules.filter(
      (r) => r.trigger === 'on_interval' && r.intervalMs !== undefined && r.intervalMs > 0,
    );

    if (intervalRules.length === 0) return;

    // Use the minimum interval among all on_interval rules
    const minInterval = Math.min(...intervalRules.map((r) => r.intervalMs!));

    this.autoSnapshotIntervalTimer = setInterval(async () => {
      for (const rule of intervalRules) {
        const prefix = rule.labelPrefix ?? 'auto';
        const label = `${prefix}: interval (${new Date().toISOString()})`;

        const id = await this.createFullSnapshot({
          label,
          triggerReason: 'auto',
        });

        if (rule.maxSnapshots !== undefined && rule.maxSnapshots > 0) {
          await this.cleanupOldSnapshots(rule.maxSnapshots);
        }

        this.emit('auto-snapshot', { id, trigger: 'on_interval', rule });
      }
    }, minInterval);
  }

  /**
   * Stop the interval timer if running.
   */
  private stopIntervalTimer(): void {
    if (this.autoSnapshotIntervalTimer !== null) {
      clearInterval(this.autoSnapshotIntervalTimer);
      this.autoSnapshotIntervalTimer = null;
    }
  }
}
