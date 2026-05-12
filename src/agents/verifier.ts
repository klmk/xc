/**
 * agents/verifier.ts
 *
 * Verifier Agent -- 工具驱动的多层验证系统。
 *
 * 核心原则：测试必须使用真实工具执行，而不是让LLM"猜测"问题。
 *
 * 三层验证架构：
 *   Layer 1 - 静态验证（Static）:  tsc --noEmit, ESLint, npm run build
 *   Layer 2 - 运行时验证（Runtime）: 服务器启动, 健康检查, API端点测试
 *   Layer 3 - 业务场景验证（Business）: Playwright E2E 浏览器自动化
 *
 * LLM 仅在以下场景作为辅助：
 *   - 从规格文档生成业务测试用例（不是验证结果）
 *   - 对工具输出进行补充分析（不是替代工具）
 *
 * 测试报告输出：
 *   - JSON 格式（机器可读）
 *   - Markdown 格式（人类可读）
 *   - 按严重等级分类：critical / major / minor / info
 *   - 用户根据报告定夺哪些需要修复
 *
 * 继承 AgentBase from core/agent-base.ts。
 */

import { randomUUID } from 'node:crypto';
import type { MessageBus, Message, MessageType } from '../core/message-bus.js';
import type { AgentConfig, TaskDescriptor, TaskResult } from '../core/agent-base.js';
import { AgentBase } from '../core/agent-base.js';
import type { Logger } from '../core/logger.js';
import type { LLMClient } from '../tools/llm-client.js';
import type { FileSystemTool } from '../tools/file-system.js';
import type { Sandbox } from '../tools/sandbox.js';
import { VERIFIER_SYSTEM_PROMPT } from '../prompts/system-prompts.js';

// ─── 三层验证模块 ─────────────────────────────────────────────────────────

import { StaticVerifier } from '../tests/static-verifier.js';
import type { StaticVerificationResult } from '../tests/static-verifier.js';
import { RuntimeVerifier } from '../tests/runtime-verifier.js';
import type { RuntimeVerificationResult, RuntimeVerifyConfig } from '../tests/runtime-verifier.js';
import { BusinessVerifier } from '../tests/business-verifier.js';
import type { BusinessVerificationResult, BusinessVerifyConfig } from '../tests/business-verifier.js';
import { TestReporter } from '../tests/test-reporter.js';
import type { TestReport } from '../tests/test-reporter.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Verifier Agent 配置
 */
export interface VerifierConfig {
  id?: string;
  name?: string;
  systemPrompt?: string;
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  /** 项目根目录路径 */
  projectRoot: string;
  /** 是否启用静态验证层 */
  enableStatic?: boolean;
  /** 是否启用运行时验证层 */
  enableRuntime?: boolean;
  /** 是否启用业务场景验证层 */
  enableBusiness?: boolean;
  /** 测试报告输出目录 */
  reportOutputDir?: string;
  /** 运行时验证配置 */
  runtimeConfig?: RuntimeVerifyConfig;
  /** 业务场景验证配置 */
  businessConfig?: BusinessVerifyConfig;
  /** 规格文档路径（用于生成业务测试用例） */
  specPath?: string;
}

/**
 * 完整验证结果（包含三层）
 */
export interface FullVerificationResult {
  reportId: string;
  timestamp: string;
  overallResult: 'pass' | 'fail' | 'warn';
  staticResult?: StaticVerificationResult;
  runtimeResult?: RuntimeVerificationResult;
  businessResult?: BusinessVerificationResult;
  report: TestReport;
  reportFiles?: {
    jsonPath: string;
    markdownPath: string;
  };
}

// ─── Verifier Agent ──────────────────────────────────────────────────────────

export class VerifierAgent extends AgentBase {
  private fs: FileSystemTool;
  private projectRoot: string;

  // 三层验证器
  private staticVerifier: StaticVerifier;
  private runtimeVerifier: RuntimeVerifier;
  private businessVerifier: BusinessVerifier;
  private reporter: TestReporter;

  // 配置
  private enableStatic: boolean;
  private enableRuntime: boolean;
  private enableBusiness: boolean;
  private reportOutputDir: string;
  private runtimeConfig?: RuntimeVerifyConfig;
  private businessConfig?: BusinessVerifyConfig;
  private specPath: string;

  constructor(
    config: VerifierConfig,
    messageBus: MessageBus,
    llm: LLMClient,
    fs: FileSystemTool,
    sandbox: Sandbox,
    logger?: Logger,
  ) {
    const agentConfig: AgentConfig = {
      id: config.id,
      name: config.name ?? 'verifier',
      systemPrompt: config.systemPrompt ?? VERIFIER_SYSTEM_PROMPT,
      maxIterations: config.maxIterations ?? 20,
      temperature: config.temperature ?? 0.2,
      maxTokens: config.maxTokens ?? 16384,
    };

    super(agentConfig, messageBus, logger);

    this.fs = fs;
    this.projectRoot = config.projectRoot;

    // 初始化三层验证器
    this.staticVerifier = new StaticVerifier(sandbox, config.projectRoot, fs);
    this.runtimeVerifier = new RuntimeVerifier(sandbox, config.projectRoot, fs);
    this.businessVerifier = new BusinessVerifier(sandbox, config.projectRoot, fs, llm);
    this.reporter = new TestReporter();

    // 配置项
    this.enableStatic = config.enableStatic ?? true;
    this.enableRuntime = config.enableRuntime ?? true;
    this.enableBusiness = config.enableBusiness ?? true;
    this.reportOutputDir = config.reportOutputDir ?? 'test-results';
    this.runtimeConfig = config.runtimeConfig;
    this.businessConfig = config.businessConfig;
    this.specPath = config.specPath ?? 'docs/PRD.md';
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  protected getSubscribedMessageTypes(): MessageType[] {
    return ['task_assigned'];
  }

  protected async handleMessage(message: Message): Promise<void> {
    if (message.type === 'task_assigned' && message.to === this.id) {
      await this.handleTaskAssignment(message);
    }
  }

  // ─── Main Entry Point ──────────────────────────────────────────────────

  /**
   * 执行验证任务。根据任务类型路由到相应处理逻辑。
   */
  async execute(task: TaskDescriptor): Promise<TaskResult> {
    if (!this.isReady() && this.getStatus() !== 'busy') {
      return this.createFailureResult('Agent not initialized');
    }

    this.setStatus('busy');
    this.setActiveTask(task.id);
    this.clearHistory();

    this.addUserMessage(
      `[Task ${task.id}] ${task.type}: ${task.title}\n${task.description}`,
    );

    try {
      let result: TaskResult;

      switch (task.type) {
        case 'verify_full':
          result = await this.runFullVerification(task);
          break;
        case 'verify_static':
          result = await this.runStaticOnly(task);
          break;
        case 'verify_runtime':
          result = await this.runRuntimeOnly(task);
          break;
        case 'verify_business':
          result = await this.runBusinessOnly(task);
          break;
        default:
          result = await this.runFullVerification(task);
          break;
      }

      this.setStatus('ready');
      this.setActiveTask(null);
      return result;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error('Task execution failed', { taskId: task.id, error: errorMessage });
      this.setStatus('ready');
      this.setActiveTask(null);
      return this.createFailureResult(errorMessage);
    }
  }

  // ─── Task Assignment Handler ───────────────────────────────────────────

  private async handleTaskAssignment(message: Message): Promise<void> {
    const task = message.payload as TaskDescriptor;
    this.logger.info('Received verifier task assignment', {
      taskId: task.id,
      type: task.type,
      title: task.title,
    });

    const result = await this.execute(task);

    if (result.success) {
      this.respond(message, 'task_completed', result);
    } else {
      this.respond(message, 'task_failed', {
        error: result.error,
        taskId: task.id,
      });
    }
  }

  // ─── Full Verification (三层全部执行) ──────────────────────────────────

  /**
   * 执行完整的三层验证：
   *   1. 静态验证（编译/Lint/构建）
   *   2. 运行时验证（启动/健康检查/API测试）
   *   3. 业务场景验证（Playwright E2E）
   *
   * 每层的结果都会被收集，最终生成统一的测试报告。
   */
  private async runFullVerification(task: TaskDescriptor): Promise<TaskResult> {
    this.logger.info('Starting full three-layer verification', { title: task.title });

    const startTime = Date.now();
    const logs: string[] = [];
    const verificationId = randomUUID();

    let staticResult: StaticVerificationResult | undefined;
    let runtimeResult: RuntimeVerificationResult | undefined;
    let businessResult: BusinessVerificationResult | undefined;

    // ── Layer 1: 静态验证 ──
    if (this.enableStatic) {
      logs.push('[Layer 1/3] Starting static verification...');
      try {
        staticResult = await this.staticVerifier.verify();
        logs.push(`[Layer 1/3] Static verification complete: ${staticResult.passed ? 'PASSED' : 'FAILED'} (${staticResult.duration}ms)`);
        logs.push(staticResult.summary);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logs.push(`[Layer 1/3] Static verification error: ${msg}`);
        this.logger.warn('Static verification failed', { error: msg });
      }
    } else {
      logs.push('[Layer 1/3] Static verification skipped (disabled)');
    }

    // ── Layer 2: 运行时验证 ──
    if (this.enableRuntime) {
      logs.push('[Layer 2/3] Starting runtime verification...');
      try {
        runtimeResult = await this.runtimeVerifier.verify(this.runtimeConfig);
        logs.push(`[Layer 2/3] Runtime verification complete: ${runtimeResult.passed ? 'PASSED' : 'FAILED'} (${runtimeResult.duration}ms)`);
        logs.push(runtimeResult.summary);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logs.push(`[Layer 2/3] Runtime verification error: ${msg}`);
        this.logger.warn('Runtime verification failed', { error: msg });
      }
    } else {
      logs.push('[Layer 2/3] Runtime verification skipped (disabled)');
    }

    // ── Layer 3: 业务场景验证 ──
    if (this.enableBusiness) {
      logs.push('[Layer 3/3] Starting business scenario verification...');

      // 尝试读取规格文档用于生成测试用例
      let specContent: string | undefined;
      try {
        const exists = await this.fs.exists(this.specPath);
        if (exists) {
          specContent = await this.fs.readFile(this.specPath);
        }
      } catch {
        // 规格文档不存在，业务验证仍可继续（如果有预定义场景）
      }

      try {
        const bizConfig: BusinessVerifyConfig = {
          ...this.businessConfig,
          specContent,
        };
        businessResult = await this.businessVerifier.verify(bizConfig);
        logs.push(`[Layer 3/3] Business verification complete: ${businessResult.passed ? 'PASSED' : 'FAILED'} (${businessResult.duration}ms)`);
        logs.push(businessResult.summary);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logs.push(`[Layer 3/3] Business verification error: ${msg}`);
        this.logger.warn('Business verification failed', { error: msg });
      }
    } else {
      logs.push('[Layer 3/3] Business scenario verification skipped (disabled)');
    }

    // ── 生成测试报告 ──
    const report = this.reporter.generateReport({
      static: staticResult,
      runtime: runtimeResult,
      business: businessResult,
      projectRoot: this.projectRoot,
    });

    logs.push('');
    logs.push('=== Test Report ===');
    logs.push(report.summary);

    // 保存报告文件
    let reportFiles: { jsonPath: string; markdownPath: string } | undefined;
    try {
      reportFiles = await this.reporter.saveReport(report, this.reportOutputDir);
      logs.push(`Report saved: ${reportFiles.jsonPath}`);
      logs.push(`Report saved: ${reportFiles.markdownPath}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logs.push(`Failed to save report: ${msg}`);
      this.logger.warn('Failed to save test report', { error: msg });
    }

    // 发布验证结果到 MessageBus
    this.publishVerificationResult(report, verificationId);

    const totalDuration = Date.now() - startTime;
    logs.push(`Total verification time: ${totalDuration}ms`);

    this.addAssistantMessage(
      `Verification ${verificationId}: ${report.overallResult.toUpperCase()}. ` +
      `${report.stats.totalIssues} issues found (${report.stats.critical} critical, ${report.stats.major} major).`,
    );

    // 构建完整结果
    const fullResult: FullVerificationResult = {
      reportId: verificationId,
      timestamp: new Date().toISOString(),
      overallResult: report.overallResult,
      staticResult,
      runtimeResult,
      businessResult,
      report,
      reportFiles,
    };

    if (report.overallResult === 'fail') {
      return this.createFailureResult(
        `Verification failed: ${report.stats.critical} critical issue(s) found. See test report for details.`,
        logs,
      );
    }

    return this.createSuccessResult(
      { verificationResult: fullResult },
      reportFiles ? [reportFiles.jsonPath, reportFiles.markdownPath] : [],
      logs,
    );
  }

  // ─── Single Layer: Static Only ─────────────────────────────────────────

  private async runStaticOnly(task: TaskDescriptor): Promise<TaskResult> {
    this.logger.info('Running static-only verification', { title: task.title });

    const logs: string[] = [];

    try {
      const result = await this.staticVerifier.verify();
      logs.push(`Static verification: ${result.passed ? 'PASSED' : 'FAILED'}`);
      logs.push(result.summary);

      const report = this.reporter.generateReport({
        static: result,
        projectRoot: this.projectRoot,
      });

      return this.createSuccessResult(
        { staticResult: result, report },
        [],
        logs,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.createFailureResult(`Static verification failed: ${msg}`, logs);
    }
  }

  // ─── Single Layer: Runtime Only ────────────────────────────────────────

  private async runRuntimeOnly(task: TaskDescriptor): Promise<TaskResult> {
    this.logger.info('Running runtime-only verification', { title: task.title });

    const logs: string[] = [];
    const config = (task.payload as RuntimeVerifyConfig) ?? this.runtimeConfig;

    try {
      const result = await this.runtimeVerifier.verify(config);
      logs.push(`Runtime verification: ${result.passed ? 'PASSED' : 'FAILED'}`);
      logs.push(result.summary);

      const report = this.reporter.generateReport({
        runtime: result,
        projectRoot: this.projectRoot,
      });

      return this.createSuccessResult(
        { runtimeResult: result, report },
        [],
        logs,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.createFailureResult(`Runtime verification failed: ${msg}`, logs);
    }
  }

  // ─── Single Layer: Business Only ───────────────────────────────────────

  private async runBusinessOnly(task: TaskDescriptor): Promise<TaskResult> {
    this.logger.info('Running business-only verification', { title: task.title });

    const logs: string[] = [];

    // 读取规格文档
    let specContent: string | undefined;
    try {
      const exists = await this.fs.exists(this.specPath);
      if (exists) {
        specContent = await this.fs.readFile(this.specPath);
      }
    } catch {
      // continue without spec
    }

    try {
      const config: BusinessVerifyConfig = {
        ...this.businessConfig,
        ...(task.payload as BusinessVerifyConfig),
        specContent,
      };

      const result = await this.businessVerifier.verify(config);
      logs.push(`Business verification: ${result.passed ? 'PASSED' : 'FAILED'}`);
      logs.push(result.summary);

      const report = this.reporter.generateReport({
        business: result,
        projectRoot: this.projectRoot,
      });

      return this.createSuccessResult(
        { businessResult: result, report },
        result.screenshots,
        logs,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.createFailureResult(`Business verification failed: ${msg}`, logs);
    }
  }

  // ─── Message Bus Publishing ────────────────────────────────────────────

  /**
   * 发布验证结果到 MessageBus。
   * Orchestrator 和其他 Agent 可以订阅此消息来获取测试结果。
   */
  private publishVerificationResult(report: TestReport, verificationId: string): void {
    this.publish('review_result', '*', {
      verificationId,
      overallResult: report.overallResult,
      stats: report.stats,
      reportId: report.reportId,
      timestamp: report.timestamp,
    }, this.getActiveTaskId() ?? undefined);

    this.logger.info('Published verification report', {
      id: report.reportId,
      result: report.overallResult,
      issues: report.stats.totalIssues,
      critical: report.stats.critical,
    });
  }
}
