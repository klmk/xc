import simpleGit, { SimpleGit } from 'simple-git';
import type { FileSystemTool } from './file-system.js';

export interface GitConfig {
  remoteUrl?: string;
  branch?: string;
  userName?: string;
  userEmail?: string;
  token?: string;
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
  async createBranch(branchName: string, checkout: boolean = true): Promise<void> {
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
}