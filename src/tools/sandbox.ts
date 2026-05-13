import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import type { SandboxConfig } from '../types/index.js';

const execAsync = promisify(exec);

export interface SandboxExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
}

export class Sandbox {
  private config: SandboxConfig;

  constructor(config: SandboxConfig) {
    this.config = config;
  }

  /**
   * 检查命令是否在允许列表中
   */
  private isCommandAllowed(command: string): boolean {
    const cmd = command.trim().split(' ')[0];
    return this.config.allowedCommands.includes(cmd);
  }

  /**
   * 使用bubblewrap执行命令（如果可用）
   */
  private async executeWithBubblewrap(
    command: string,
    args: string[] = [],
    cwd?: string
  ): Promise<SandboxExecutionResult> {
    const startTime = Date.now();
    
    // bubblewrap参数
    const bwrapArgs = [
      '--bind', this.config.projectPath, '/app',
      '--chdir', '/app',
      '--unshare-all',
      '--die-with-parent',
      '--new-session',
    ];

    // 网络控制
    if (!this.config.networkEnabled) {
      bwrapArgs.push('--unshare-net');
    }

    // 资源限制（通过cgroups或ulimit）
    // 注意：bubblewrap本身不直接支持内存限制，需要配合cgroups

    const fullCommand = ['bwrap', ...bwrapArgs, '--', command, ...args];

    return new Promise((resolve) => {
      const child = spawn(fullCommand[0], fullCommand.slice(1), {
        cwd: cwd || this.config.projectPath,
        timeout: this.config.timeout,
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (exitCode) => {
        resolve({
          success: exitCode === 0,
          stdout,
          stderr,
          exitCode: exitCode || 0,
          duration: Date.now() - startTime,
        });
      });

      child.on('error', (error) => {
        resolve({
          success: false,
          stdout,
          stderr: stderr || error.message,
          exitCode: -1,
          duration: Date.now() - startTime,
        });
      });
    });
  }

  /**
   * 使用子进程直接执行（降级方案）
   */
  private async executeDirect(
    command: string,
    args: string[] = [],
    cwd?: string
  ): Promise<SandboxExecutionResult> {
    const startTime = Date.now();

    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: cwd || this.config.projectPath,
        timeout: this.config.timeout,
        env: {
          ...process.env,
          // 限制环境变量
          PATH: '/usr/local/bin:/usr/bin:/bin',
        },
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (exitCode) => {
        resolve({
          success: exitCode === 0,
          stdout,
          stderr,
          exitCode: exitCode || 0,
          duration: Date.now() - startTime,
        });
      });

      child.on('error', (error) => {
        resolve({
          success: false,
          stdout,
          stderr: stderr || error.message,
          exitCode: -1,
          duration: Date.now() - startTime,
        });
      });
    });
  }

  /**
   * 检查bubblewrap是否可用
   */
  private async isBubblewrapAvailable(): Promise<boolean> {
    try {
      await execAsync('which bwrap');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 执行命令
   */
  async execute(
    command: string,
    args: string[] = [],
    cwd?: string
  ): Promise<SandboxExecutionResult> {
    // 安全检查
    if (!this.isCommandAllowed(command)) {
      return {
        success: false,
        stdout: '',
        stderr: `Command '${command}' is not in the allowed list`,
        exitCode: -1,
        duration: 0,
      };
    }

    // 尝试使用bubblewrap，否则降级到直接执行
    const useBubblewrap = await this.isBubblewrapAvailable();
    
    if (useBubblewrap) {
      return this.executeWithBubblewrap(command, args, cwd);
    } else {
      console.warn('Bubblewrap not available, using direct execution (less secure)');
      return this.executeDirect(command, args, cwd);
    }
  }

  /**
   * 执行Node.js脚本
   */
  async executeNode(scriptPath: string): Promise<SandboxExecutionResult> {
    return this.execute('node', [scriptPath]);
  }

  /**
   * 执行npm命令
   */
  async executeNpm(args: string[]): Promise<SandboxExecutionResult> {
    return this.execute('npm', args);
  }

  /**
   * 执行npx命令
   */
  async executeNpx(args: string[]): Promise<SandboxExecutionResult> {
    return this.execute('npx', args);
  }

  /**
   * 安装依赖
   */
  async installDependencies(packages?: string[]): Promise<SandboxExecutionResult> {
    if (packages && packages.length > 0) {
      return this.executeNpm(['install', ...packages]);
    }
    return this.executeNpm(['install']);
  }

  /**
   * 运行测试
   */
  async runTests(testCommand: string = 'test'): Promise<SandboxExecutionResult> {
    return this.executeNpm(['run', testCommand]);
  }

  /**
   * 启动开发服务器（用于E2E测试）
   */
  async startDevServer(port: number = 3000): Promise<{
    process: ReturnType<typeof spawn>;
    stop: () => Promise<void>;
  }> {
    const child = spawn('npm', ['run', 'dev'], {
      cwd: this.config.projectPath,
      env: {
        ...process.env,
        PORT: port.toString(),
      },
    });

    // 等待服务器启动
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server start timeout'));
      }, 30000);

      child.stdout?.on('data', (data) => {
        const output = data.toString();
        if (output.includes('ready') || output.includes('localhost') || output.includes('http://')) {
          clearTimeout(timeout);
          resolve();
        }
      });

      child.stderr?.on('data', (data) => {
        // 某些框架把启动信息输出到stderr
        const output = data.toString();
        if (output.includes('ready') || output.includes('localhost')) {
          clearTimeout(timeout);
          resolve();
        }
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    return {
      process: child,
      stop: async () => {
        child.kill('SIGTERM');
        // 等待进程结束
        await new Promise<void>((resolve) => {
          child.on('close', () => resolve());
          setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 5000);
        });
      },
    };
  }
}