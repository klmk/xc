import { promises as fs, existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type { CodeFile } from '../types/index.js';

export class FileSystemTool {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = resolve(basePath);
    this.ensureDirectory(this.basePath);
  }

  /**
   * 确保目录存在
   */
  private ensureDirectory(dirPath: string): void {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * 解析相对路径（防止目录遍历）
   */
  private resolvePath(filePath: string): string {
    const resolved = resolve(this.basePath, filePath);
    if (!resolved.startsWith(this.basePath)) {
      throw new Error('Path traversal detected');
    }
    return resolved;
  }

  /**
   * 写入文件
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    const fullPath = this.resolvePath(filePath);
    this.ensureDirectory(dirname(fullPath));
    await fs.writeFile(fullPath, content, 'utf-8');
  }

  /**
   * 读取文件
   */
  async readFile(filePath: string): Promise<string> {
    const fullPath = this.resolvePath(filePath);
    return fs.readFile(fullPath, 'utf-8');
  }

  /**
   * 检查文件是否存在
   */
  async exists(filePath: string): Promise<boolean> {
    try {
      const fullPath = this.resolvePath(filePath);
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 删除文件
   */
  async deleteFile(filePath: string): Promise<void> {
    const fullPath = this.resolvePath(filePath);
    await fs.unlink(fullPath);
  }

  /**
   * 创建目录
   */
  async createDirectory(dirPath: string): Promise<void> {
    const fullPath = this.resolvePath(dirPath);
    this.ensureDirectory(fullPath);
  }

  /**
   * 列出目录内容
   */
  async listDirectory(dirPath: string = ''): Promise<string[]> {
    const fullPath = this.resolvePath(dirPath);
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    return entries.map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      path: join(dirPath, entry.name),
    })) as unknown as string[];
  }

  /**
   * 递归列出所有文件
   */
  async listAllFiles(dirPath: string = ''): Promise<string[]> {
    const fullPath = this.resolvePath(dirPath);
    const files: string[] = [];

    const traverse = async (currentPath: string, relativePath: string) => {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const entryRelativePath = relativePath ? join(relativePath, entry.name) : entry.name;
        const entryFullPath = join(currentPath, entry.name);
        
        if (entry.isDirectory()) {
          await traverse(entryFullPath, entryRelativePath);
        } else {
          files.push(entryRelativePath);
        }
      }
    };

    await traverse(fullPath, dirPath);
    return files;
  }

  /**
   * 批量写入代码文件
   */
  async writeCodeFiles(files: CodeFile[]): Promise<void> {
    for (const file of files) {
      await this.writeFile(file.path, file.content);
    }
  }

  /**
   * 读取多个文件内容
   */
  async readFiles(filePaths: string[]): Promise<Map<string, string>> {
    const contents = new Map<string, string>();
    
    for (const path of filePaths) {
      try {
        const content = await this.readFile(path);
        contents.set(path, content);
      } catch (error) {
        console.warn(`Failed to read file ${path}:`, error);
      }
    }
    
    return contents;
  }

  /**
   * 获取项目结构摘要
   */
  async getProjectStructure(): Promise<string> {
    const files = await this.listAllFiles();
    const structure: string[] = [];

    for (const file of files) {
      try {
        const content = await this.readFile(file);
        const lines = content.split('\n').length;
        structure.push(`${file} (${lines} lines)`);
      } catch {
        structure.push(file);
      }
    }

    return structure.join('\n');
  }

  /**
   * 获取文件路径
   */
  getFullPath(filePath: string): string {
    return this.resolvePath(filePath);
  }

  /**
   * 获取项目根路径
   */
  getBasePath(): string {
    return this.basePath;
  }
}