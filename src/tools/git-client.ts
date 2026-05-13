import { simpleGit, type SimpleGit } from 'simple-git';
import type { FileSystemTool } from './file-system.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';

export interface GitConfig {
  remoteUrl?: string;
  branch?: string;
  userName?: string;
  userEmail?: string;
  token?: string;
}

export interface CheckpointMeta {
  id: string;
  message: string;
  createdAt: string;
  commitHash: string;
  branch: string;
  filesChanged: string[];
}

export class GitClient {
  private git: SimpleGit;
  private fs: FileSystemTool;
  private config: Required<GitConfig>;

  constructor(fs: FileSystemTool, config: GitConfig = {}) {
    this.fs = fs;
    this.config = {
      remoteUrl: '',
      branch: 'main',
      userName: 'AI Developer',
      userEmail: 'ai@dev.platform',
      token: '',
      ...config,
    };

    this.git = simpleGit(fs.getBasePath());
  }

  /**
   * 初始化Git仓库
   */
  async init(): Promise<void> {
    const isRepo = await this.git.checkIsRepo();
    if (!isRepo) {
      await this.git.init();
      await this.git.addConfig('user.name', this.config.userName);
      await this.git.addConfig('user.email', this.config.userEmail);

      // 创建初始提交
      await this.git.add('.');
      await this.git.commit('Initial commit: Project setup by AI');

      // 重命名分支
      await this.git.branch(['-m', this.config.branch]);
    }
  }

  /**
   * 关联远程仓库
   */
  async addRemote(url: string, name: string = 'origin'): Promise<void> {
    const remotes = await this.git.getRemotes();
    const existing = remotes.find(r => r.name === name);

    if (existing) {
      await this.git.removeRemote(name);
    }

    // 如果有token，添加到URL
    let remoteUrl = url;
    if (this.config.token && url.includes('github.com')) {
      remoteUrl = url.replace(
        'https://github.com/',
        `https://${this.config.token}@github.com/`
      );
    }

    await this.git.addRemote(name, remoteUrl);
  }

  /**
   * 提交更改
   */
  async commit(message: string, files: string[] = ['.']): Promise<void> {
    await this.git.add(files);
    const status = await this.git.status();

    if (status.staged.length > 0 || status.not_added.length > 0) {
      await this.git.commit(message);
    }
  }

  /**
   * 推送到远程
   */
  async push(remote: string = 'origin', branch?: string): Promise<void> {
    const targetBranch = branch || this.config.branch;
    await this.git.push(remote, targetBranch);
  }

  /**
   * 拉取更新
   */
  async pull(remote: string = 'origin', branch?: string): Promise<void> {
    const targetBranch = branch || this.config.branch;
    await this.git.pull(remote, targetBranch);
  }

  /**
   * 获取状态
   */
  async status(): Promise<{
    staged: string[];
    modified: string[];
    notAdded: string[];
    deleted: string[];
    ahead: number;
    behind: number;
  }> {
    const status = await this.git.status();
    return {
      staged: status.staged,
      modified: status.modified,
      notAdded: status.not_added,
      deleted: status.deleted,
      ahead: status.ahead,
      behind: status.behind,
    };
  }

  /**
   * 创建分支
   */
  async createBranch(branchName: string, _checkout: boolean = true): Promise<void> {
    await this.git.checkoutLocalBranch(branchName);
  }

  /**
   * 切换分支
   */
  async checkout(branchName: string): Promise<void> {
    await this.git.checkout(branchName);
  }

  /**
   * 获取提交历史
   */
  async log(maxCount: number = 10): Promise<{
    hash: string;
    message: string;
    author: string;
    date: string;
  }[]> {
    const log = await this.git.log({ maxCount });
    return log.all.map(commit => ({
      hash: commit.hash,
      message: commit.message,
      author: commit.author_name,
      date: commit.date,
    }));
  }

  /**
   * 自动保存（commit + push）
   */
  async autoSave(message: string): Promise<void> {
    await this.commit(message);

    if (this.config.remoteUrl) {
      try {
        await this.push();
      } catch (error) {
        console.warn('Push failed, changes committed locally:', error);
      }
    }
  }

  /**
   * 任务完成后保存
   */
  async saveTaskCompletion(taskName: string, details?: string): Promise<void> {
    const message = details
      ? `feat: ${taskName}\n\n${details}`
      : `feat: ${taskName}`;
    await this.autoSave(message);
  }

  /**
   * 修复后保存
   */
  async saveFix(issue: string, attempt: number): Promise<void> {
    const message = `fix: ${issue} (attempt ${attempt})`;
    await this.autoSave(message);
  }

  /**
   * 获取当前分支
   */
  async getCurrentBranch(): Promise<string> {
    const status = await this.git.status();
    return status.current || this.config.branch;
  }

  /**
   * 检查是否有未提交的更改
   */
  async hasUncommittedChanges(): Promise<boolean> {
    const status = await this.git.status();
    return status.files.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Worktree management (inspired by Claude Code and Cursor)
  // ---------------------------------------------------------------------------

  /**
   * Get the main worktree path (the original repo directory).
   */
  getMainWorktreePath(): string {
    return this.fs.getBasePath();
  }

  /**
   * Create a git worktree for parallel agent isolation.
   * @param worktreeName - Name for the worktree (e.g., "agent-1", "feat-auth")
   * @param branchName - Branch to checkout in the worktree (created if doesn't exist)
   * @returns Absolute path to the worktree directory
   */
  async createWorktree(worktreeName: string, branchName: string): Promise<string> {
    const basePath = this.getMainWorktreePath();
    const worktreeDir = path.join(basePath, '.ai-dev', 'worktrees', worktreeName);

    // Ensure the parent directory exists
    const parentDir = path.dirname(worktreeDir);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // Check if the branch already exists (locally or remotely)
    const branches = await this.git.branchLocal();
    const branchExists = branches.all.includes(branchName);

    if (branchExists) {
      // Checkout existing branch into the worktree
      await this.git.raw(['worktree', 'add', worktreeDir, branchName]);
    } else {
      // Create a new branch from current HEAD
      await this.git.raw(['worktree', 'add', worktreeDir, '-b', branchName]);
    }

    return worktreeDir;
  }

  /**
   * List all worktrees in the repository.
   */
  async listWorktrees(): Promise<Array<{
    path: string;
    branch: string;
    isMain: boolean;
  }>> {
    const mainPath = this.getMainWorktreePath();
    const result = await this.git.raw(['worktree', 'list', '--porcelain']);

    const worktrees: Array<{ path: string; branch: string; isMain: boolean }> = [];
    let currentPath = '';
    let currentBranch = '';

    for (const line of result.trim().split('\n')) {
      if (line.startsWith('worktree ')) {
        // Save previous entry if we have one
        if (currentPath) {
          worktrees.push({
            path: currentPath,
            branch: currentBranch,
            isMain: path.resolve(currentPath) === path.resolve(mainPath),
          });
        }
        currentPath = line.substring('worktree '.length).trim();
        currentBranch = '';
      } else if (line.startsWith('branch ')) {
        // Extract branch name from refs/heads/...
        const ref = line.substring('branch '.length).trim();
        if (ref.startsWith('refs/heads/')) {
          currentBranch = ref.substring('refs/heads/'.length);
        } else {
          currentBranch = ref;
        }
      }
    }

    // Don't forget the last entry
    if (currentPath) {
      worktrees.push({
        path: currentPath,
        branch: currentBranch,
        isMain: path.resolve(currentPath) === path.resolve(mainPath),
      });
    }

    return worktrees;
  }

  /**
   * Remove a worktree.
   */
  async removeWorktree(worktreePath: string, force: boolean = false): Promise<void> {
    const args = ['worktree', 'remove'];
    if (force) {
      args.push('--force');
    }
    args.push(worktreePath);
    await this.git.raw(args);
  }

  // ---------------------------------------------------------------------------
  // Automatic checkpoints (inspired by Claude Code's edit-before-snapshot)
  // ---------------------------------------------------------------------------

  /**
   * Get the directory where checkpoint metadata is stored.
   */
  private getCheckpointsDir(): string {
    return path.join(this.getMainWorktreePath(), '.ai-dev', 'checkpoints');
  }

  /**
   * Ensure the checkpoints directory exists.
   */
  private ensureCheckpointsDir(): void {
    const dir = this.getCheckpointsDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Create a checkpoint - stash current changes + commit with a tag.
   * This is called automatically before significant edits.
   */
  async createCheckpoint(message: string): Promise<CheckpointMeta> {
    const id = randomUUID();
    const tagName = `checkpoint-${id}`;
    const branch = await this.getCurrentBranch();

    // 1. Stage all current changes
    await this.git.add('-A');

    // 2. Check if there is anything to commit
    const status = await this.git.status();
    const filesChanged = [
      ...status.staged,
      ...status.modified,
      ...status.not_added,
      ...status.deleted,
    ];

    if (filesChanged.length === 0) {
      // Even with no changes, create a checkpoint on the current HEAD
      const head = await this.git.revparse(['HEAD']);
      const commitHash = head.trim();

      const meta: CheckpointMeta = {
        id,
        message,
        createdAt: new Date().toISOString(),
        commitHash,
        branch,
        filesChanged: [],
      };

      // Tag the current commit
      await this.git.raw(['tag', tagName, commitHash]);

      // Persist metadata
      this.ensureCheckpointsDir();
      fs.writeFileSync(
        path.join(this.getCheckpointsDir(), `${id}.json`),
        JSON.stringify(meta, null, 2),
        'utf-8'
      );

      return meta;
    }

    // 3. Create a commit with checkpoint prefix
    const commitMessage = `[checkpoint] ${message}`;
    const commitResult = await this.git.commit(commitMessage);
    const commitHash = commitResult.commit || (await this.git.revparse(['HEAD'])).trim();

    // 4. Create a git tag pointing to this commit
    await this.git.raw(['tag', tagName]);

    const meta: CheckpointMeta = {
      id,
      message,
      createdAt: new Date().toISOString(),
      commitHash,
      branch,
      filesChanged,
    };

    // 5. Persist metadata to disk
    this.ensureCheckpointsDir();
    fs.writeFileSync(
      path.join(this.getCheckpointsDir(), `${id}.json`),
      JSON.stringify(meta, null, 2),
      'utf-8'
    );

    return meta;
  }

  /**
   * List all checkpoints.
   */
  async listCheckpoints(): Promise<CheckpointMeta[]> {
    const dir = this.getCheckpointsDir();
    if (!fs.existsSync(dir)) {
      return [];
    }

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

    const checkpoints: CheckpointMeta[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
        const meta: CheckpointMeta = JSON.parse(raw);
        checkpoints.push(meta);
      } catch {
        // Skip corrupted checkpoint files
      }
    }

    // Sort by creation time descending (newest first)
    checkpoints.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return checkpoints;
  }

  /**
   * Roll back to a specific checkpoint.
   * Resets working tree and HEAD to the checkpoint's commit.
   */
  async rollbackToCheckpoint(checkpointId: string): Promise<void> {
    // 1. Load checkpoint metadata
    const metaPath = path.join(this.getCheckpointsDir(), `${checkpointId}.json`);
    if (!fs.existsSync(metaPath)) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    const meta: CheckpointMeta = JSON.parse(
      fs.readFileSync(metaPath, 'utf-8')
    );

    // 2. Verify the tag exists
    const tagName = `checkpoint-${checkpointId}`;
    try {
      await this.git.raw(['rev-parse', tagName]);
    } catch {
      throw new Error(`Git tag '${tagName}' not found for checkpoint ${checkpointId}`);
    }

    // 3. Hard reset to the checkpoint commit
    await this.git.raw(['reset', '--hard', meta.commitHash]);

    // 4. Log the rollback
    console.log(
      `[GitClient] Rolled back to checkpoint ${checkpointId} (${meta.commitHash}) - "${meta.message}"`
    );
  }

  /**
   * Get the latest checkpoint.
   */
  async getLatestCheckpoint(): Promise<CheckpointMeta | null> {
    const checkpoints = await this.listCheckpoints();
    return checkpoints.length > 0 ? checkpoints[0] : null;
  }

  // ---------------------------------------------------------------------------
  // Enhanced auto-commit with conventional commits
  // ---------------------------------------------------------------------------

  /**
   * Smart auto-save that detects what changed and generates appropriate commit messages.
   */
  async smartAutoSave(
    description: string,
    type: 'feat' | 'fix' | 'refactor' | 'test' | 'chore' | 'docs' = 'chore'
  ): Promise<string> {
    const status = await this.git.status();
    const allChanged = [
      ...status.staged,
      ...status.modified,
      ...status.not_added,
      ...status.deleted,
    ];

    // Build a conventional commit message
    const scope = this.inferScope(allChanged);
    const commitMessage = scope
      ? `${type}(${scope}): ${description}`
      : `${type}: ${description}`;

    // Include changed files summary in the body
    if (allChanged.length > 0) {
      const fileList = allChanged.map(f => `  - ${f}`).join('\n');
      const fullMessage = `${commitMessage}\n\nChanged files:\n${fileList}`;
      await this.autoSave(fullMessage);
    } else {
      await this.autoSave(commitMessage);
    }

    // Return the commit hash
    const head = await this.git.revparse(['HEAD']);
    return head.trim();
  }

  /**
   * Infer a conventional-commit scope from the list of changed files.
   * For example, files under `src/tools/` produce scope "tools".
   */
  private inferScope(files: string[]): string | null {
    if (files.length === 0) {
      return null;
    }

    // Collect the first meaningful directory segment for each file
    const segments = new Map<string, number>();
    for (const file of files) {
      const normalized = file.replace(/\\/g, '/');
      const parts = normalized.split('/').filter(Boolean);

      // Use the first directory as a potential scope (skip single-file root changes)
      if (parts.length >= 2) {
        const scope = parts[0];
        segments.set(scope, (segments.get(scope) || 0) + 1);
      }
    }

    if (segments.size === 0) {
      return null;
    }

    // Pick the most common directory segment
    let bestScope: string | null = null;
    let bestCount = 0;
    for (const [scope, count] of segments) {
      if (count > bestCount) {
        bestCount = count;
        bestScope = scope;
      }
    }

    return bestScope;
  }
}
