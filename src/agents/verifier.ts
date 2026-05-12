/**
 * agents/verifier.ts
 *
 * Verifier Agent -- 对规格文档进行对抗性验证。
 *
 * 职责：
 *   - 通过 MessageBus 接收验证请求 (topic: 'verify_request')
 *   - 根据架构师的规格文档验证代码（不仅仅是运行测试）
 *   - 四个验证维度：
 *     1. 功能性：代码是否实现了规格说明的内容？
 *     2. 一致性：模块接口在整个代码库中是否匹配？
 *     3. 边界性：边界情况（空值、null、负数、极端值）
 *     4. 数据规则：是否强制执行了数据约束（例如 amount >= 0）？
 *   - 发现跨模块不一致（核心价值）
 *   - 报告带有严重程度级别的结构化问题
 *   - 不修复代码 - 仅报告问题供 Builder 修复
 *
 * 继承 AgentBase from core/agent-base.ts。
 * 验证结果始终为结构化对象。
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
  specPath?: string;
  architecturePath?: string;
  maxIssuesPerCategory?: number;
  failOnCritical?: boolean;
}

/**
 * 验证问题 - 核心输出结构
 */
export interface VerificationIssue {
  severity: 'critical' | 'major' | 'minor' | 'info';
  category: 'functional' | 'consistency' | 'boundary' | 'data_rule' | 'security';
  module: string;
  file: string;
  line?: number;
  description: string;
  specReference: string;
  suggestion: string;
}

/**
 * 验证报告 - 完整的验证结果
 */
export interface VerificationReport {
  verificationId: string;
  timestamp: string;
  overallResult: 'pass' | 'fail' | 'warn';
  summary: string;
  dimensions: {
    functional: DimensionResult;
    consistency: DimensionResult;
    boundary: DimensionResult;
    dataRule: DimensionResult;
  };
  issues: VerificationIssue[];
  stats: {
    total: number;
    critical: number;
    major: number;
    minor: number;
    info: number;
  };
  filesVerified: string[];
  specVersion: string;
  duration: number;
}

/**
 * 单个维度的验证结果
 */
export interface DimensionResult {
  passed: boolean;
  score: number; // 0-100
  issuesFound: number;
  description: string;
}

/**
 * 验证请求负载
 */
export interface VerifyRequestPayload {
  targetFiles?: string[];
  dimensions?: Array<'functional' | 'consistency' | 'boundary' | 'data_rule' | 'security'>;
  focusAreas?: string[];
  specSections?: string[];
}

/**
 * 规格规则引用
 */
export interface SpecRule {
  id: string;
  section: string;
  rule: string;
  priority: 'must' | 'should' | 'may';
}

// ─── Verifier Agent ──────────────────────────────────────────────────────────

export class VerifierAgent extends AgentBase {
  private llm: LLMClient;
  private fs: FileSystemTool;
  private sandbox: Sandbox;
  private specPath: string;
  private architecturePath: string;
  private maxIssuesPerCategory: number;
  private failOnCritical: boolean;

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

    this.llm = llm;
    this.fs = fs;
    this.sandbox = sandbox;
    this.specPath = config.specPath ?? 'docs/PRD.md';
    this.architecturePath = config.architecturePath ?? 'docs/ARCHITECTURE.md';
    this.maxIssuesPerCategory = config.maxIssuesPerCategory ?? 20;
    this.failOnCritical = config.failOnCritical ?? true;
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

    // 清理历史记录，保持独立上下文窗口
    this.clearHistory();

    this.addUserMessage(
      `[Task ${task.id}] ${task.type}: ${task.title}\n${task.description}`,
    );

    try {
      let result: TaskResult;

      switch (task.type) {
        case 'verify_request':
          result = await this.handleVerifyRequest(task);
          break;
        case 'verify_functional':
          result = await this.verifyFunctional(task);
          break;
        case 'verify_consistency':
          result = await this.verifyConsistency(task);
          break;
        case 'verify_boundary':
          result = await this.verifyBoundary(task);
          break;
        case 'verify_data_rules':
          result = await this.verifyDataRules(task);
          break;
        default:
          result = await this.handleVerifyRequest(task);
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

  /**
   * 处理从 MessageBus 接收的 task_assigned 消息。
   * 执行验证任务并通过 task_completed 或 task_failed 响应。
   */
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

  // ─── Full Verification Request ─────────────────────────────────────────

  /**
   * 处理完整的验证请求：在所有维度上验证代码。
   * 这是 Verifier 的核心工作流。
   */
  private async handleVerifyRequest(task: TaskDescriptor): Promise<TaskResult> {
    this.logger.info('Processing full verification request', { title: task.title });

    const startTime = Date.now();
    const payload = task.payload as VerifyRequestPayload;
    const logs: string[] = [];
    const verificationId = randomUUID();

    // 确定要验证的文件
    const targetFiles = await this.resolveTargetFiles(payload.targetFiles);
    logs.push(`Target files: ${targetFiles.length} files to verify`);

    // 确定要验证的维度
    const dimensions = payload.dimensions ?? ['functional', 'consistency', 'boundary', 'data_rule', 'security'];
    logs.push(`Dimensions: ${dimensions.join(', ')}`);

    // 读取规格文档
    const specContent = await this.readSpecContent();
    const archContent = await this.readArchitectureContent();

    // 提取规格规则
    const specRules = this.extractSpecRules(specContent);
    logs.push(`Spec rules extracted: ${specRules.length} rules`);

    // 读取目标文件内容
    const fileContents = await this.fs.readFiles(targetFiles);
    logs.push(`Files read: ${fileContents.size} files loaded`);

    // 在每个维度上执行验证
    const allIssues: VerificationIssue[] = [];
    const dimensionResults: VerificationReport['dimensions'] = {
      functional: { passed: true, score: 100, issuesFound: 0, description: '' },
      consistency: { passed: true, score: 100, issuesFound: 0, description: '' },
      boundary: { passed: true, score: 100, issuesFound: 0, description: '' },
      dataRule: { passed: true, score: 100, issuesFound: 0, description: '' },
    };

    // 维度 1: 功能性验证
    if (dimensions.includes('functional')) {
      logs.push('Running functional verification...');
      const result = await this.runFunctionalVerification(fileContents, specContent, specRules);
      allIssues.push(...result.issues);
      dimensionResults.functional = result.dimension;
      logs.push(`Functional: ${result.issues.length} issues found, score: ${result.dimension.score}`);
    }

    // 维度 2: 一致性验证
    if (dimensions.includes('consistency')) {
      logs.push('Running consistency verification...');
      const result = await this.runConsistencyVerification(fileContents, archContent);
      allIssues.push(...result.issues);
      dimensionResults.consistency = result.dimension;
      logs.push(`Consistency: ${result.issues.length} issues found, score: ${result.dimension.score}`);
    }

    // 维度 3: 边界值验证
    if (dimensions.includes('boundary')) {
      logs.push('Running boundary verification...');
      const result = await this.runBoundaryVerification(fileContents, specContent);
      allIssues.push(...result.issues);
      dimensionResults.boundary = result.dimension;
      logs.push(`Boundary: ${result.issues.length} issues found, score: ${result.dimension.score}`);
    }

    // 维度 4: 数据规则验证
    if (dimensions.includes('data_rule')) {
      logs.push('Running data rule verification...');
      const result = await this.runDataRuleVerification(fileContents, specContent, specRules);
      allIssues.push(...result.issues);
      dimensionResults.dataRule = result.dimension;
      logs.push(`Data rules: ${result.issues.length} issues found, score: ${result.dimension.score}`);
    }

    // 维度 5: 安全性验证
    if (dimensions.includes('security')) {
      logs.push('Running security verification...');
      const securityIssues = await this.runSecurityVerification(fileContents);
      allIssues.push(...securityIssues);
      logs.push(`Security: ${securityIssues.length} issues found`);
    }

    // 计算统计信息
    const stats = {
      total: allIssues.length,
      critical: allIssues.filter(i => i.severity === 'critical').length,
      major: allIssues.filter(i => i.severity === 'major').length,
      minor: allIssues.filter(i => i.severity === 'minor').length,
      info: allIssues.filter(i => i.severity === 'info').length,
    };

    // 确定总体结果
    const hasCritical = stats.critical > 0;
    const hasMajor = stats.major > 0;
    const overallResult: 'pass' | 'fail' | 'warn' = hasCritical
      ? 'fail'
      : hasMajor
        ? 'warn'
        : 'pass';

    // 生成摘要
    const summary = this.generateSummary(overallResult, stats, dimensionResults);

    const duration = Date.now() - startTime;

    // 构建验证报告
    const report: VerificationReport = {
      verificationId,
      timestamp: new Date().toISOString(),
      overallResult,
      summary,
      dimensions: dimensionResults,
      issues: allIssues,
      stats,
      filesVerified: targetFiles,
      specVersion: await this.getSpecVersion(),
      duration,
    };

    // 发布验证结果
    this.publishVerificationResult(report);

    logs.push(`Verification complete: ${overallResult} (${duration}ms)`);
    logs.push(`Issues: ${stats.critical} critical, ${stats.major} major, ${stats.minor} minor, ${stats.info} info`);

    this.addAssistantMessage(
      `Verification ${verificationId}: ${overallResult}. ${stats.total} issues found (${stats.critical} critical).`,
    );

    // 如果存在严重问题且配置为失败，则返回失败
    if (hasCritical && this.failOnCritical) {
      return this.createFailureResult(
        `Verification failed: ${stats.critical} critical issue(s) found`,
        logs,
      );
    }

    return this.createSuccessResult(
      { verificationReport: report },
      [],
      logs,
    );
  }

  // ─── Dimension 1: Functional Verification ──────────────────────────────

  /**
   * 执行独立的功能性验证任务
   */
  private async verifyFunctional(task: TaskDescriptor): Promise<TaskResult> {
    this.logger.info('Running standalone functional verification', { title: task.title });

    const payload = task.payload as VerifyRequestPayload;
    const targetFiles = await this.resolveTargetFiles(payload.targetFiles);
    const specContent = await this.readSpecContent();
    const specRules = this.extractSpecRules(specContent);
    const fileContents = await this.fs.readFiles(targetFiles);

    const result = await this.runFunctionalVerification(fileContents, specContent, specRules);

    return this.createSuccessResult(
      {
        dimension: 'functional',
        issues: result.issues,
        result: result.dimension,
      },
      [],
      [`Functional verification: ${result.issues.length} issues, score: ${result.dimension.score}`],
    );
  }

  /**
   * 功能性验证：代码是否实现了规格说明的内容？
   * 这是验证的核心维度 - 对比代码实现与规格要求。
   */
  private async runFunctionalVerification(
    fileContents: Map<string, string>,
    specContent: string,
    specRules: SpecRule[],
  ): Promise<{ issues: VerificationIssue[]; dimension: DimensionResult }> {
    const issues: VerificationIssue[] = [];

    // 构建代码上下文
    const codeContext = Array.from(fileContents.entries())
      .map(([path, content]) => `// === ${path} ===\n${content.substring(0, 4000)}`)
      .join('\n\n');

    // 构建规格规则摘要
    const rulesSummary = specRules
      .filter(r => r.priority === 'must')
      .map(r => `[${r.id}] ${r.section}: ${r.rule}`)
      .join('\n');

    const prompt = `You are an adversarial code verifier. Your job is to find gaps between the specification and the implementation.

## Specification (PRD)
${specContent.substring(0, 6000)}

## Must-Have Spec Rules
${rulesSummary}

## Implementation Code
${codeContext}

## Verification Task
For each spec requirement, check if the code ACTUALLY implements it. Be thorough and adversarial.
Look for:
1. Specified features that are completely missing from the code
2. Features that are partially implemented (e.g., UI exists but logic is missing)
3. Specified behaviors that differ from the actual implementation
4. Specified error handling that is not implemented
5. Specified validations that are missing
6. API endpoints or functions specified in the spec but not in the code

For each issue found, provide:
- severity: critical (feature missing) | major (partial implementation) | minor (minor deviation) | info (observation)
- category: "functional"
- module: which module the issue belongs to
- file: the specific file path
- line: approximate line number if possible
- description: clear description of the gap
- specReference: which spec rule or section is violated
- suggestion: how to fix it

Respond in JSON format:
{
  "issues": [{
    "severity": "critical" | "major" | "minor" | "info",
    "category": "functional",
    "module": "module name",
    "file": "file path",
    "line": number or null,
    "description": "what's wrong",
    "specReference": "which spec rule is violated",
    "suggestion": "how to fix"
  }],
  "score": number (0-100, 100 = perfect implementation)
}

IMPORTANT: Be thorough. Check EVERY spec requirement against the code.
If the code fully implements the spec, return an empty issues array and score 100.`;

    try {
      const result = await this.llm.completeStructured<{
        issues: VerificationIssue[];
        score: number;
      }>(prompt, {
        issues: [{
          severity: 'string',
          category: 'string',
          module: 'string',
          file: 'string',
          line: 'number',
          description: 'string',
          specReference: 'string',
          suggestion: 'string',
        }],
        score: 'number',
      });

      // 限制每个类别的最大问题数
      const limitedIssues = result.issues.slice(0, this.maxIssuesPerCategory);
      const score = Math.max(0, Math.min(100, result.score));

      return {
        issues: limitedIssues,
        dimension: {
          passed: score >= 70 && limitedIssues.filter(i => i.severity === 'critical').length === 0,
          score,
          issuesFound: limitedIssues.length,
          description: limitedIssues.length === 0
            ? 'All functional requirements are implemented correctly'
            : `${limitedIssues.length} functional issue(s) found, score ${score}/100`,
        },
      };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn('Functional verification LLM call failed', { error: errorMessage });
      return {
        issues: [],
        dimension: {
          passed: true,
          score: 0,
          issuesFound: 0,
          description: `Functional verification could not be completed: ${errorMessage}`,
        },
      };
    }
  }

  // ─── Dimension 2: Consistency Verification ─────────────────────────────

  /**
   * 执行独立的一致性验证任务
   */
  private async verifyConsistency(task: TaskDescriptor): Promise<TaskResult> {
    this.logger.info('Running standalone consistency verification', { title: task.title });

    const payload = task.payload as VerifyRequestPayload;
    const targetFiles = await this.resolveTargetFiles(payload.targetFiles);
    const archContent = await this.readArchitectureContent();
    const fileContents = await this.fs.readFiles(targetFiles);

    const result = await this.runConsistencyVerification(fileContents, archContent);

    return this.createSuccessResult(
      {
        dimension: 'consistency',
        issues: result.issues,
        result: result.dimension,
      },
      [],
      [`Consistency verification: ${result.issues.length} issues, score: ${result.dimension.score}`],
    );
  }

  /**
   * 一致性验证：模块接口在整个代码库中是否匹配？
   * 这是 Verifier 的核心价值 - 发现跨模块不一致。
   */
  private async runConsistencyVerification(
    fileContents: Map<string, string>,
    archContent: string,
  ): Promise<{ issues: VerificationIssue[]; dimension: DimensionResult }> {
    const issues: VerificationIssue[] = [];

    // 构建代码上下文
    const codeContext = Array.from(fileContents.entries())
      .map(([path, content]) => `// === ${path} ===\n${content.substring(0, 4000)}`)
      .join('\n\n');

    const prompt = `You are an adversarial code consistency verifier. Your job is to find cross-module inconsistencies.

${archContent ? `## Architecture Document\n${archContent.substring(0, 3000)}\n\n` : ''}

## Codebase
${codeContext}

## Consistency Checks
Perform these checks thoroughly:

1. IMPORT/EXPORT MISMATCH:
   - Are all imported symbols actually exported from their source modules?
   - Are there imports from files that don't exist?
   - Are there exported symbols that are never imported anywhere?

2. TYPE INTERFACE CONSISTENCY:
   - Do function parameter types match between caller and callee?
   - Do return types match what callers expect?
   - Are shared interfaces defined consistently across modules?
   - Are there type assertions (as, !) that hide type mismatches?

3. API CONTRACT CONSISTENCY:
   - Do REST API endpoints match their type definitions?
   - Do database schema types match the application types?
   - Do event payloads match their handler expectations?

4. NAMING CONVENTION CONSISTENCY:
   - Are the same concepts named consistently across modules?
   - Are there similar but differently named types or functions?

5. ERROR HANDLING CONSISTENCY:
   - Do modules handle errors from other modules consistently?
   - Are error types consistent across module boundaries?

6. CONFIGURATION CONSISTENCY:
   - Are environment variables used consistently?
   - Are default values consistent across modules?

For each issue found, provide:
- severity: critical (will cause runtime errors) | major (causes incorrect behavior) | minor (style/inconsistency) | info (observation)
- category: "consistency"
- module: which module has the issue
- file: the specific file path
- line: approximate line number if possible
- description: clear description of the inconsistency
- specReference: reference to the architecture doc or interface definition
- suggestion: how to fix it

Respond in JSON format:
{
  "issues": [...],
  "score": number (0-100)
}

IMPORTANT: Focus on issues that would cause ACTUAL bugs or runtime errors.
Minor naming inconsistencies should be 'info' severity.`;

    try {
      const result = await this.llm.completeStructured<{
        issues: VerificationIssue[];
        score: number;
      }>(prompt, {
        issues: [{
          severity: 'string',
          category: 'string',
          module: 'string',
          file: 'string',
          line: 'number',
          description: 'string',
          specReference: 'string',
          suggestion: 'string',
        }],
        score: 'number',
      });

      const limitedIssues = result.issues.slice(0, this.maxIssuesPerCategory);
      const score = Math.max(0, Math.min(100, result.score));

      return {
        issues: limitedIssues,
        dimension: {
          passed: score >= 70 && limitedIssues.filter(i => i.severity === 'critical').length === 0,
          score,
          issuesFound: limitedIssues.length,
          description: limitedIssues.length === 0
            ? 'All module interfaces are consistent'
            : `${limitedIssues.length} consistency issue(s) found, score ${score}/100`,
        },
      };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn('Consistency verification LLM call failed', { error: errorMessage });
      return {
        issues: [],
        dimension: {
          passed: true,
          score: 0,
          issuesFound: 0,
          description: `Consistency verification could not be completed: ${errorMessage}`,
        },
      };
    }
  }

  // ─── Dimension 3: Boundary Verification ────────────────────────────────

  /**
   * 执行独立的边界值验证任务
   */
  private async verifyBoundary(task: TaskDescriptor): Promise<TaskResult> {
    this.logger.info('Running standalone boundary verification', { title: task.title });

    const payload = task.payload as VerifyRequestPayload;
    const targetFiles = await this.resolveTargetFiles(payload.targetFiles);
    const specContent = await this.readSpecContent();
    const fileContents = await this.fs.readFiles(targetFiles);

    const result = await this.runBoundaryVerification(fileContents, specContent);

    return this.createSuccessResult(
      {
        dimension: 'boundary',
        issues: result.issues,
        result: result.dimension,
      },
      [],
      [`Boundary verification: ${result.issues.length} issues, score: ${result.dimension.score}`],
    );
  }

  /**
   * 边界值验证：代码是否正确处理了边界情况？
   * 检查空值、null、负数、极端值等。
   */
  private async runBoundaryVerification(
    fileContents: Map<string, string>,
    specContent: string,
  ): Promise<{ issues: VerificationIssue[]; dimension: DimensionResult }> {
    const issues: VerificationIssue[] = [];

    // 构建代码上下文
    const codeContext = Array.from(fileContents.entries())
      .map(([path, content]) => `// === ${path} ===\n${content.substring(0, 4000)}`)
      .join('\n\n');

    const prompt = `You are an adversarial boundary condition verifier. Your job is to find unhandled edge cases.

## Specification
${specContent.substring(0, 3000)}

## Implementation Code
${codeContext}

## Boundary Conditions to Check
For each function, method, and handler in the code, verify it handles:

1. EMPTY INPUTS:
   - Empty string ("")
   - Empty array ([])"
   - Empty object ({})"
   - Zero (0)
   - Empty Map/Set

2. NULL/UNDEFINED:
   - null passed as argument
   - undefined passed as argument
   - Optional parameters not provided
   - Missing properties on objects

3. EXTREME VALUES:
   - Very large numbers (Number.MAX_SAFE_INTEGER, Infinity)
   - Very small numbers (Number.MIN_SAFE_INTEGER, -Infinity, -0)
   - Very long strings (10000+ characters)
   - Very large arrays (10000+ elements)
   - NaN

4. NEGATIVE VALUES:
   - Negative numbers where only positive is expected
   - Negative array indices
   - Negative dates

5. TYPE MISMATCHES:
   - String where number is expected
   - Number where string is expected
   - Object where primitive is expected
   - Array where single value is expected

6. SPECIAL CASES:
   - Duplicate entries in arrays
   - Unicode characters in strings
   - Nested objects/arrays (deep recursion risk)
   - Concurrent/parallel access patterns

For each issue found:
- severity: critical (crash/security risk) | major (incorrect behavior) | minor (unhandled but non-critical) | info (could be better)
- category: "boundary"
- module, file, line, description, specReference, suggestion

Respond in JSON format:
{
  "issues": [...],
  "score": number (0-100)
}

IMPORTANT: Only report REAL issues, not theoretical ones.
If a function already handles a boundary case (even if simply), don't report it.`;

    try {
      const result = await this.llm.completeStructured<{
        issues: VerificationIssue[];
        score: number;
      }>(prompt, {
        issues: [{
          severity: 'string',
          category: 'string',
          module: 'string',
          file: 'string',
          line: 'number',
          description: 'string',
          specReference: 'string',
          suggestion: 'string',
        }],
        score: 'number',
      });

      const limitedIssues = result.issues.slice(0, this.maxIssuesPerCategory);
      const score = Math.max(0, Math.min(100, result.score));

      return {
        issues: limitedIssues,
        dimension: {
          passed: score >= 70 && limitedIssues.filter(i => i.severity === 'critical').length === 0,
          score,
          issuesFound: limitedIssues.length,
          description: limitedIssues.length === 0
            ? 'Boundary conditions are properly handled'
            : `${limitedIssues.length} boundary issue(s) found, score ${score}/100`,
        },
      };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn('Boundary verification LLM call failed', { error: errorMessage });
      return {
        issues: [],
        dimension: {
          passed: true,
          score: 0,
          issuesFound: 0,
          description: `Boundary verification could not be completed: ${errorMessage}`,
        },
      };
    }
  }

  // ─── Dimension 4: Data Rule Verification ───────────────────────────────

  /**
   * 执行独立的数据规则验证任务
   */
  private async verifyDataRules(task: TaskDescriptor): Promise<TaskResult> {
    this.logger.info('Running standalone data rule verification', { title: task.title });

    const payload = task.payload as VerifyRequestPayload;
    const targetFiles = await this.resolveTargetFiles(payload.targetFiles);
    const specContent = await this.readSpecContent();
    const specRules = this.extractSpecRules(specContent);
    const fileContents = await this.fs.readFiles(targetFiles);

    const result = await this.runDataRuleVerification(fileContents, specContent, specRules);

    return this.createSuccessResult(
      {
        dimension: 'data_rule',
        issues: result.issues,
        result: result.dimension,
      },
      [],
      [`Data rule verification: ${result.issues.length} issues, score: ${result.dimension.score}`],
    );
  }

  /**
   * 数据规则验证：数据约束是否被正确执行？
   * 检查数据验证、类型约束、业务规则等。
   */
  private async runDataRuleVerification(
    fileContents: Map<string, string>,
    specContent: string,
    specRules: SpecRule[],
  ): Promise<{ issues: VerificationIssue[]; dimension: DimensionResult }> {
    const issues: VerificationIssue[] = [];

    // 构建代码上下文
    const codeContext = Array.from(fileContents.entries())
      .map(([path, content]) => `// === ${path} ===\n${content.substring(0, 4000)}`)
      .join('\n\n');

    // 提取数据相关的规格规则
    const dataRules = specRules.filter(r =>
      r.rule.toLowerCase().includes('valid') ||
      r.rule.toLowerCase().includes('constraint') ||
      r.rule.toLowerCase().includes('must be') ||
      r.rule.toLowerCase().includes('should be') ||
      r.rule.toLowerCase().includes('required') ||
      r.rule.toLowerCase().includes('unique') ||
      r.rule.toLowerCase().includes('format'),
    );

    const rulesText = dataRules.length > 0
      ? dataRules.map(r => `[${r.id}] ${r.section}: ${r.rule}`).join('\n')
      : 'No explicit data rules found in spec. Verify common data constraints.';

    const prompt = `You are an adversarial data rule verifier. Your job is to find missing or incorrect data validations.

## Specification
${specContent.substring(0, 4000)}

## Data Rules from Spec
${rulesText}

## Implementation Code
${codeContext}

## Data Rule Checks
Verify the following categories of data constraints:

1. INPUT VALIDATION:
   - Are all required fields validated for presence?
   - Are string fields validated for format (email, URL, phone, etc.)?
   - Are numeric fields validated for range (min, max)?
   - Are enum fields validated against allowed values?
   - Are date fields validated for reasonable ranges?

2. BUSINESS RULE ENFORCEMENT:
   - Are business constraints enforced (e.g., "amount must be >= 0")?
   - Are state transition rules enforced (e.g., can't go from 'deleted' to 'active')?
   - Are uniqueness constraints enforced?
   - Are referential integrity constraints enforced?

3. DATA TRANSFORMATION RULES:
   - Are calculations correct (totals, subtotals, tax)?
   - Are currency values properly rounded?
   - Are date/time conversions handled correctly (timezone)?
   - Are string normalizations applied (trim, lowercase)?

4. DATA PERSISTENCE RULES:
   - Are default values set correctly?
   - Are timestamps managed properly (created_at, updated_at)?
   - Are soft deletes handled correctly?
   - Are data migrations considered?

5. OUTPUT VALIDATION:
   - Are API responses validated before sending?
   - Are displayed values formatted correctly?
   - Are sensitive fields properly masked/omitted?

For each issue found:
- severity: critical (data corruption risk) | major (incorrect business logic) | minor (missing validation) | info (suggestion)
- category: "data_rule"
- module, file, line, description, specReference, suggestion

Respond in JSON format:
{
  "issues": [...],
  "score": number (0-100)
}

IMPORTANT: Focus on rules that could lead to DATA CORRUPTION or INCORRECT BUSINESS BEHAVIOR.
Missing format validation for non-critical fields should be 'minor' or 'info'.`;

    try {
      const result = await this.llm.completeStructured<{
        issues: VerificationIssue[];
        score: number;
      }>(prompt, {
        issues: [{
          severity: 'string',
          category: 'string',
          module: 'string',
          file: 'string',
          line: 'number',
          description: 'string',
          specReference: 'string',
          suggestion: 'string',
        }],
        score: 'number',
      });

      const limitedIssues = result.issues.slice(0, this.maxIssuesPerCategory);
      const score = Math.max(0, Math.min(100, result.score));

      return {
        issues: limitedIssues,
        dimension: {
          passed: score >= 70 && limitedIssues.filter(i => i.severity === 'critical').length === 0,
          score,
          issuesFound: limitedIssues.length,
          description: limitedIssues.length === 0
            ? 'All data rules are properly enforced'
            : `${limitedIssues.length} data rule issue(s) found, score ${score}/100`,
        },
      };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn('Data rule verification LLM call failed', { error: errorMessage });
      return {
        issues: [],
        dimension: {
          passed: true,
          score: 0,
          issuesFound: 0,
          description: `Data rule verification could not be completed: ${errorMessage}`,
        },
      };
    }
  }

  // ─── Security Verification (Bonus Dimension) ───────────────────────────

  /**
   * 安全性验证：检查常见的安全漏洞。
   */
  private async runSecurityVerification(
    fileContents: Map<string, string>,
  ): Promise<VerificationIssue[]> {
    const issues: VerificationIssue[] = [];

    // 构建代码上下文
    const codeContext = Array.from(fileContents.entries())
      .map(([path, content]) => `// === ${path} ===\n${content.substring(0, 3000)}`)
      .join('\n\n');

    const prompt = `You are a security auditor. Find security vulnerabilities in the code.

## Code
${codeContext}

## Security Checks
1. SQL Injection: Are query parameters properly sanitized/parameterized?
2. XSS: Is user input properly escaped before rendering?
3. Command Injection: Are shell commands constructed from user input?
4. Path Traversal: Are file paths validated against directory traversal?
5. Hardcoded Secrets: Are API keys, passwords, or tokens in the code?
6. Insecure Deserialization: Is JSON.parse used on untrusted input?
7. Prototype Pollution: Is object merging done unsafely?
8. ReDoS: Are regex patterns vulnerable to denial of service?
9. Information Leakage: Is sensitive data exposed in logs or errors?
10. Authentication/Authorization: Are auth checks missing?

For each vulnerability found:
- severity: critical (exploitable) | major (significant risk) | minor (low risk) | info (best practice)
- category: "security"
- module, file, line, description, specReference ("SEC-001" etc.), suggestion

Respond in JSON format:
{
  "issues": [...]
}

Only report REAL vulnerabilities, not theoretical ones.`;

    try {
      const result = await this.llm.completeStructured<{
        issues: VerificationIssue[];
      }>(prompt, {
        issues: [{
          severity: 'string',
          category: 'string',
          module: 'string',
          file: 'string',
          line: 'number',
          description: 'string',
          specReference: 'string',
          suggestion: 'string',
        }],
      });

      return result.issues.slice(0, this.maxIssuesPerCategory);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn('Security verification LLM call failed', { error: errorMessage });
      return [];
    }
  }

  // ─── Spec Rule Extraction ──────────────────────────────────────────────

  /**
   * 从规格文档中提取结构化规则。
   * 支持 Markdown 格式的 PRD 文档。
   */
  private extractSpecRules(specContent: string): SpecRule[] {
    const rules: SpecRule[] = [];
    let ruleIndex = 0;

    // 提取 "must", "should", "shall" 等关键词所在的句子
    const sentences = specContent.split(/[.!?]\s+/);
    const priorityKeywords = {
      must: ['must', 'shall', 'required', 'has to', 'needs to'],
      should: ['should', 'ought to', 'recommended', 'prefer'],
      may: ['may', 'can', 'could', 'optional'],
    };

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (trimmed.length < 10 || trimmed.length > 500) continue;

      const lowerSentence = trimmed.toLowerCase();

      // 确定优先级
      let priority: 'must' | 'should' | 'may' | null = null;
      for (const [p, keywords] of Object.entries(priorityKeywords)) {
        if (keywords.some(kw => lowerSentence.includes(kw))) {
          priority = p as 'must' | 'should' | 'may';
          break;
        }
      }

      if (!priority) continue;

      ruleIndex++;

      // 尝试确定规则所属的章节
      const sectionMatch = specContent.substring(
        Math.max(0, specContent.indexOf(trimmed) - 200),
        specContent.indexOf(trimmed),
      ).match(/^(#{1,4})\s+(.+)$/m);

      rules.push({
        id: `SPEC-${String(ruleIndex).padStart(3, '0')}`,
        section: sectionMatch ? sectionMatch[2].trim() : 'General',
        rule: trimmed,
        priority,
      });
    }

    return rules;
  }

  // ─── Report Generation ─────────────────────────────────────────────────

  /**
   * 生成验证摘要
   */
  private generateSummary(
    overallResult: 'pass' | 'fail' | 'warn',
    stats: { total: number; critical: number; major: number; minor: number; info: number },
    dimensions: VerificationReport['dimensions'],
  ): string {
    const parts: string[] = [];

    switch (overallResult) {
      case 'pass':
        parts.push('Verification PASSED. The code implementation meets the specification requirements.');
        break;
      case 'warn':
        parts.push(`Verification PASSED WITH WARNINGS. ${stats.major} major issue(s) need attention.`);
        break;
      case 'fail':
        parts.push(`Verification FAILED. ${stats.critical} critical issue(s) must be fixed before deployment.`);
        break;
    }

    parts.push(`Total issues: ${stats.total} (${stats.critical} critical, ${stats.major} major, ${stats.minor} minor, ${stats.info} info).`);

    // 维度摘要
    const dimSummaries: string[] = [];
    if (dimensions.functional.issuesFound > 0) {
      dimSummaries.push(`Functional: ${dimensions.functional.issuesFound} issues (score ${dimensions.functional.score})`);
    }
    if (dimensions.consistency.issuesFound > 0) {
      dimSummaries.push(`Consistency: ${dimensions.consistency.issuesFound} issues (score ${dimensions.consistency.score})`);
    }
    if (dimensions.boundary.issuesFound > 0) {
      dimSummaries.push(`Boundary: ${dimensions.boundary.issuesFound} issues (score ${dimensions.boundary.score})`);
    }
    if (dimensions.dataRule.issuesFound > 0) {
      dimSummaries.push(`Data Rules: ${dimensions.dataRule.issuesFound} issues (score ${dimensions.dataRule.score})`);
    }

    if (dimSummaries.length > 0) {
      parts.push(`By dimension: ${dimSummaries.join('; ')}.`);
    }

    return parts.join(' ');
  }

  // ─── Message Bus Publishing ────────────────────────────────────────────

  /**
   * 发布验证结果到 MessageBus。
   * 确保所有消费者都能收到结构化的验证报告。
   */
  private publishVerificationResult(report: VerificationReport): void {
    this.publish('review_result', '*', report, this.getActiveTaskId() ?? undefined);
    this.logger.info('Published verification report', {
      id: report.verificationId,
      result: report.overallResult,
      issues: report.stats.total,
      critical: report.stats.critical,
    });
  }

  // ─── Target File Resolution ────────────────────────────────────────────

  /**
   * 解析目标文件列表。如果未提供，则自动发现所有源文件。
   */
  private async resolveTargetFiles(targetFiles?: string[]): Promise<string[]> {
    if (targetFiles && targetFiles.length > 0) {
      return targetFiles;
    }

    try {
      const allFiles = await this.fs.listAllFiles();
      return allFiles.filter(f =>
        /\.(ts|js|tsx|jsx)$/.test(f) &&
        !f.includes('node_modules') &&
        !f.includes('dist/') &&
        !f.includes('build/') &&
        !f.includes('.test.') &&
        !f.includes('.spec.') &&
        !f.includes('.config.'),
      );
    } catch {
      return [];
    }
  }

  // ─── Context Helpers ──────────────────────────────────────────────────

  /**
   * 读取规格文档内容
   */
  private async readSpecContent(): Promise<string> {
    try {
      const exists = await this.fs.exists(this.specPath);
      if (exists) {
        return await this.fs.readFile(this.specPath);
      }
      return 'No specification document found';
    } catch {
      return 'Error reading specification document';
    }
  }

  /**
   * 读取架构文档内容
   */
  private async readArchitectureContent(): Promise<string> {
    try {
      const exists = await this.fs.exists(this.architecturePath);
      if (exists) {
        return await this.fs.readFile(this.architecturePath);
      }
      return '';
    } catch {
      return '';
    }
  }

  /**
   * 获取规格文档版本信息
   */
  private async getSpecVersion(): Promise<string> {
    try {
      const content = await this.readSpecContent();
      // 尝试从文档中提取版本号
      const versionMatch = content.match(/(?:version|v)[:\s]+(\d+\.\d+(?:\.\d+)?)/i);
      return versionMatch ? versionMatch[1] : 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
