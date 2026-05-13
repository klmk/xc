#!/usr/bin/env node

/**
 * AI Dev Platform v2.0 - 入口
 *
 * 多Agent协作的全自动化软件开发平台
 * 借鉴 Claude Code 架构：消息总线 + 独立Agent + 并行执行 + Hooks
 */

import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import chalk from 'chalk';
import ora from 'ora';

import { MessageBus } from './core/message-bus.js';
import { Logger } from './core/logger.js';
import { ProjectConfigLoader } from './core/project-config.js';
import { LLMClient } from './tools/llm-client.js';
import { FileSystemTool } from './tools/file-system.js';
import { GitClient } from './tools/git-client.js';
import { Sandbox } from './tools/sandbox.js';
import { OrchestratorAgent } from './agents/orchestrator.js';
import { ExplorerAgent } from './agents/explorer.js';
import { ArchitectAgent } from './agents/architect.js';
import { DeveloperAgent } from './agents/developer.js';
import { VerifierAgent } from './agents/verifier.js';
import { EvolverAgent } from './agents/evolver.js';

// ─── 配置 ─────────────────────────────────────────────────────────────────

interface PlatformConfig {
  deepseekApiKey: string;
  githubToken?: string;
  projectsDir: string;
  maxConcurrency: number;
  verbose: boolean;
}

// ─── 平台主类 ──────────────────────────────────────────────────────────────

class AIDevPlatform {
  private config: PlatformConfig;
  private logger: Logger;

  constructor(config: PlatformConfig) {
    this.config = config;
    this.logger = new Logger({ minLevel: config.verbose ? 'debug' : 'info' });
  }

  /**
   * 创建新项目 - 核心流程
   */
  async createProject(requirement: string, projectName: string): Promise<void> {
    this.printBanner();
    this.logger.info(`项目: ${chalk.cyan(projectName)}`);
    this.logger.info(`需求: ${chalk.gray(requirement)}`);

    const spinner = ora('初始化平台...').start();

    try {
      // 1. 创建项目目录
      const projectPath = resolve(this.config.projectsDir, projectName);
      if (!existsSync(projectPath)) {
        mkdirSync(projectPath, { recursive: true });
      }

      // 2. 加载项目配置
      spinner.text = '加载项目配置...';
      const projectConfig = await ProjectConfigLoader.load(projectPath);
      this.logger.info(`技术栈: ${JSON.stringify(projectConfig.techStack)}`);

      // 3. 初始化核心基础设施
      spinner.text = '初始化消息总线...';
      const messageBus = new MessageBus();

      // 4. 初始化工具
      spinner.text = '初始化工具链...';
      const fs = new FileSystemTool(projectPath);
      const git = new GitClient(fs, {
        userName: 'AI Developer',
        userEmail: 'ai@dev.platform',
        token: this.config.githubToken,
      });
      const llm = new LLMClient({
        apiKey: this.config.deepseekApiKey,
        model: 'deepseek-chat',
        temperature: 0.7,
        maxTokens: 8192,
      });
      const sandbox = new Sandbox({
        projectPath,
        allowedCommands: ['node', 'npm', 'npx', 'git', 'ls', 'cat', 'echo', 'mkdir', 'touch', 'rm', 'tsc'],
        networkEnabled: true,
        memoryLimit: '1g',
        cpuLimit: '2.0',
        timeout: 120000,
      });

      // 5. 创建所有 Agent（每个有独立上下文）
      spinner.text = '启动 Agent 团队...';

      const orchestrator = new OrchestratorAgent(
        {},
        messageBus,
        llm,
        fs,
        git,
        this.logger,
      );

      const explorer = new ExplorerAgent({
        messageBus,
        llm,
        logger: this.logger,
        projectConfig,
      });

      const architect = new ArchitectAgent({
        messageBus,
        llm,
        fs,
        logger: this.logger,
        projectConfig,
      });

      const developer = new DeveloperAgent(
        {},
        messageBus,
        llm,
        fs,
        git,
        this.logger,
      );

      const verifier = new VerifierAgent(
        { projectRoot: projectPath },
        messageBus,
        llm,
        fs,
        sandbox,
        this.logger,
      );

      const evolver = new EvolverAgent(
        {},
        messageBus,
        llm,
        fs,
        this.logger,
      );

      // 6. 初始化所有 Agent
      await Promise.all([
        orchestrator.initialize(),
        explorer.initialize(),
        architect.initialize(),
        developer.initialize(),
        verifier.initialize(),
        evolver.initialize(),
      ]);

      spinner.succeed(chalk.green('平台初始化完成'));
      this.logger.info('');
      this.logger.info(chalk.yellow('═══ 开始自动化开发 ═══'));
      this.logger.info('');

      // 7. 监听消息总线（用于日志输出）
      this.setupMessageLogging(messageBus);

      // 8. 运行项目经理Agent
      const result = await orchestrator.execute({
        id: 'manage-project',
        type: 'manage_project',
        title: `Manage project: ${projectName}`,
        description: requirement,
        payload: {
          requirement,
          projectName,
          projectPath,
        },
      });

      // 9. 输出结果
      this.printResult(result, projectPath);

      // 10. 关闭所有 Agent
      await Promise.all([
        orchestrator.shutdown(),
        explorer.shutdown(),
        architect.shutdown(),
        developer.shutdown(),
        verifier.shutdown(),
        evolver.shutdown(),
      ]);

    } catch (error) {
      spinner.fail(chalk.red('项目创建失败'));
      this.logger.error(`${error instanceof Error ? error.message : 'Unknown error'}`);
      if (error instanceof Error && error.stack && this.config.verbose) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  }

  /**
   * 监听消息总线，输出关键事件
   */
  private setupMessageLogging(messageBus: MessageBus): void {
    const logEvents = [
      'task_assigned',
      'task_completed',
      'task_failed',
      'code_generated',
      'test_result',
      'review_result',
      'human_request',
    ] as const;

    for (const eventType of logEvents) {
      messageBus.subscribe(eventType, (msg) => {
        switch (eventType) {
          case 'task_assigned':
            this.logger.info(chalk.blue(`📋 任务分配: ${(msg.payload as any).title}`));
            break;
          case 'task_completed':
            this.logger.info(chalk.green(`✅ 任务完成: ${(msg.payload as any).title}`));
            break;
          case 'task_failed':
            this.logger.error(chalk.red(`❌ 任务失败: ${(msg.payload as any).title}`));
            break;
          case 'code_generated':
            this.logger.info(chalk.cyan(`💻 代码生成: ${(msg.payload as any).files?.length || 0} 个文件`));
            break;
          case 'test_result': {
            const r = msg.payload as any;
            if (r.success) {
              this.logger.info(chalk.green(`🧪 测试通过: ${r.passed}/${r.total}`));
            } else {
              this.logger.warn(chalk.yellow(`🧪 测试失败: ${r.passed}/${r.total}，${r.failures?.length || 0} 个失败`));
            }
            break;
          }
          case 'review_result': {
            const r = msg.payload as any;
            if (r.approved) {
              this.logger.info(chalk.green(`🔍 审查通过: 分数 ${r.score}/100`));
            } else {
              this.logger.warn(chalk.yellow(`🔍 审查未通过: 分数 ${r.score}/100，${r.issues?.length || 0} 个问题`));
            }
            break;
          }
          case 'human_request':
            this.logger.info(chalk.magenta(`🛑 需要人工介入: ${(msg.payload as any).message}`));
            break;
        }
      });
    }
  }

  /**
   * 打印启动横幅
   */
  private printBanner(): void {
    console.log('');
    console.log(chalk.blue.bold('  ╔══════════════════════════════════════╗'));
    console.log(chalk.blue.bold('  ║     AI Dev Platform v4.0            ║'));
    console.log(chalk.blue.bold('  ║     AI原生五角色自动化开发 + 并行任务 + 完整快照           ║'));
    console.log(chalk.blue.bold('  ╚══════════════════════════════════════╝'));
    console.log('');
  }

  /**
   * 打印最终结果
   */
  private printResult(result: any, projectPath: string): void {
    console.log('');
    console.log(chalk.yellow('═══ 开发完成 ═══'));
    console.log('');

    if (result.status === 'completed') {
      console.log(chalk.green.bold('  ✅ 项目交付成功！'));
      console.log(chalk.gray(`  📁 位置: ${projectPath}`));
      console.log(chalk.gray(`  📊 任务: ${result.completedTasks || 0}/${result.totalTasks || 0} 完成`));
    } else if (result.status === 'waiting_for_human') {
      console.log(chalk.yellow.bold('  ⏸️  等待人工介入'));
      console.log(chalk.yellow(`  📝 原因: ${result.message || '未知'}`));
    } else if (result.status === 'error') {
      console.log(chalk.red.bold('  ❌ 项目失败'));
      console.log(chalk.red(`  📝 错误: ${result.message || '未知'}`));
    }

    console.log('');
  }

  /**
   * 显示帮助信息
   */
  showHelp(): void {
    console.log('');
    console.log(chalk.blue.bold('  AI Dev Platform v2.0'));
    console.log(chalk.gray('  多Agent协作的全自动化软件开发平台'));
    console.log('');
    console.log(chalk.white('  用法:'));
    console.log('    ai-dev-platform create <项目名> "<需求描述>"');
    console.log('    ai-dev-platform status [项目名]');
    console.log('    ai-dev-platform help');
    console.log('');
    console.log(chalk.white('  环境变量:'));
    console.log(chalk.gray('    DEEPSEEK_API_KEY   DeepSeek API密钥（必需）'));
    console.log(chalk.gray('    GITHUB_TOKEN       GitHub Token（可选）'));
    console.log(chalk.gray('    PROJECTS_DIR       项目目录（默认: ./projects）'));
    console.log(chalk.gray('    MAX_CONCURRENCY    最大并行数（默认: 3）'));
    console.log(chalk.gray('    VERBOSE            详细日志（默认: false）'));
    console.log('');
    console.log(chalk.white('  示例:'));
    console.log(chalk.gray('    ai-dev-platform create todo-app "用React创建一个待办事项应用"'));
    console.log('');
    console.log(chalk.white('  架构:'));
    console.log(chalk.gray('    项目经理Agent → 需求分析 → 任务拆解'));
    console.log(chalk.gray('    开发Agent ←→ 测试Agent ←→ 审查Agent'));
    console.log(chalk.gray('    消息总线 + 并行执行 + Hooks系统'));
    console.log('');
  }
}

// ─── 主函数 ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const config: PlatformConfig = {
    deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
    githubToken: process.env.GITHUB_TOKEN,
    projectsDir: process.env.PROJECTS_DIR || resolve(process.cwd(), 'projects'),
    maxConcurrency: parseInt(process.env.MAX_CONCURRENCY || '3', 10),
    verbose: process.env.VERBOSE === 'true',
  };

  const platform = new AIDevPlatform(config);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    platform.showHelp();
    return;
  }

  if (command === 'create') {
    const projectName = args[1];
    const requirement = args[2];

    if (!projectName || !requirement) {
      console.error(chalk.red('错误: 项目名和需求描述是必需的'));
      console.log('\n用法: ai-dev-platform create <项目名> "<需求描述>"');
      process.exit(1);
    }

    if (!config.deepseekApiKey) {
      console.error(chalk.red('错误: 需要设置 DEEPSEEK_API_KEY 环境变量'));
      process.exit(1);
    }

    await platform.createProject(requirement, projectName);
    return;
  }

  console.error(chalk.red(`未知命令: ${command}`));
  platform.showHelp();
  process.exit(1);
}

main().catch((error) => {
  console.error(chalk.red('致命错误:'), error);
  process.exit(1);
});
