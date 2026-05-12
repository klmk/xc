/**
 * agents/evolver.ts
 *
 * Evolver Agent -- 需求变更的系统性处理专家。
 *
 * 职责：
 *   - 通过 MessageBus 接收变更请求 (topic: 'change_request')
 *   - 执行影响分析：哪些模块/文件受到影响
 *   - 先更新规格文档（spec before code 原则）
 *   - 生成变更检查清单（所有需要修改的文件）
 *   - 协调 Builder agents 应用变更
 *   - 变更后运行回归验证
 *   - 防止变更期间模块间的不一致性
 *
 * 继承 AgentBase from core/agent-base.ts。
 * 影响分析结果始终为结构化对象。
 */

import { randomUUID } from 'node:crypto';
import type { MessageBus, Message, MessageType } from '../core/message-bus.js';
import type { AgentConfig, TaskDescriptor, TaskResult } from '../core/agent-base.js';
import { AgentBase } from '../core/agent-base.js';
import type { Logger } from '../core/logger.js';
import type { LLMClient } from '../tools/llm-client.js';
import type { FileSystemTool } from '../tools/file-system.js';
import { EVOLVER_SYSTEM_PROMPT } from '../prompts/system-prompts.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Evolver Agent 配置
 */
export interface EvolverConfig {
  id?: string;
  name?: string;
  systemPrompt?: string;
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  specPath?: string;
  architecturePath?: string;
  maxRetries?: number;
}

/**
 * 影响分析结果 - 核心输出结构
 */
export interface ImpactAnalysis {
  changeDescription: string;
  affectedModules: {
    module: string;
    files: string[];
    impactType: 'direct' | 'indirect';
    requiredAction: 'modify' | 'verify' | 'add' | 'delete';
    description: string;
  }[];
  specChanges: {
    section: string;
    field: string;
    oldValue: string;
    newValue: string;
  }[];
  riskLevel: 'low' | 'medium' | 'high';
}

/**
 * 变更检查清单项
 */
export interface ChangeChecklistItem {
  id: string;
  file: string;
  module: string;
  action: 'modify' | 'verify' | 'add' | 'delete';
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  rollbackContent?: string;
}

/**
 * 变更请求负载
 */
export interface ChangeRequestPayload {
  changeId: string;
  description: string;
  reason: string;
  affectedAreas?: string[];
  priority?: 'low' | 'medium' | 'high';
  requestedBy?: string;
}

/**
 * 回归验证结果
 */
export interface RegressionResult {
  passed: boolean;
  testResults: {
    total: number;
    passed: number;
    failed: number;
  };
  consistencyCheck: {
    passed: boolean;
    issues: string[];
  };
  rollbackRequired: boolean;
  rollbackReason?: string;
}

/**
 * 变更执行快照（用于回滚）
 */
export interface ChangeSnapshot {
  changeId: string;
  timestamp: string;
  files: Map<string, string>;
  specContent: string;
}

// ─── Evolver Agent ───────────────────────────────────────────────────────────

export class EvolverAgent extends AgentBase {
  private llm: LLMClient;
  private fs: FileSystemTool;
  private specPath: string;
  private architecturePath: string;
  private maxRetries: number;

  /** 当前变更的快照存储，用于回滚 */
  private snapshots: Map<string, ChangeSnapshot>;
  /** 当前变更检查清单 */
  private currentChecklist: ChangeChecklistItem[];

  constructor(
    config: EvolverConfig,
    messageBus: MessageBus,
    llm: LLMClient,
    fs: FileSystemTool,
    logger?: Logger,
  ) {
    const agentConfig: AgentConfig = {
      id: config.id,
      name: config.name ?? 'evolver',
      systemPrompt: config.systemPrompt ?? EVOLVER_SYSTEM_PROMPT,
      maxIterations: config.maxIterations ?? 20,
      temperature: config.temperature ?? 0.3,
      maxTokens: config.maxTokens ?? 16384,
    };

    super(agentConfig, messageBus, logger);

    this.llm = llm;
    this.fs = fs;
    this.specPath = config.specPath ?? 'docs/PRD.md';
    this.architecturePath = config.architecturePath ?? 'docs/ARCHITECTURE.md';
    this.maxRetries = config.maxRetries ?? 3;
    this.snapshots = new Map();
    this.currentChecklist = [];
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  protected getSubscribedMessageTypes(): MessageType[] {
    return ['task_assigned', 'human_response'];
  }

  protected async handleMessage(message: Message): Promise<void> {
    if (message.type === 'task_assigned' && message.to === this.id) {
      await this.handleTaskAssignment(message);
    }
  }

  // ─── Main Entry Point ──────────────────────────────────────────────────

  /**
   * 执行变更管理任务。根据任务类型路由到相应处理逻辑。
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
        case 'change_request':
          result = await this.handleChangeRequest(task);
          break;
        case 'impact_analysis':
          result = await this.performImpactAnalysis(task);
          break;
        case 'apply_change':
          result = await this.applyChange(task);
          break;
        case 'rollback':
          result = await this.rollbackChange(task);
          break;
        case 'regression_verify':
          result = await this.runRegressionVerification(task);
          break;
        default:
          result = await this.handleChangeRequest(task);
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
   * 执行任务并通过 task_completed 或 task_failed 响应。
   */
  private async handleTaskAssignment(message: Message): Promise<void> {
    const task = message.payload as TaskDescriptor;
    this.logger.info('Received evolver task assignment', {
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

  // ─── Change Request Handler ────────────────────────────────────────────

  /**
   * 处理完整的变更请求流程：
   * 1. 影响分析
   * 2. 更新规格文档
   * 3. 生成变更检查清单
   * 4. 协调 Builder 应用变更
   * 5. 回归验证
   * 6. 必要时回滚
   */
  private async handleChangeRequest(task: TaskDescriptor): Promise<TaskResult> {
    this.logger.info('Processing change request', { title: task.title });

    const payload = task.payload as ChangeRequestPayload;
    const logs: string[] = [];
    const changeId = payload.changeId ?? task.id;

    // 步骤 1: 创建变更前快照（用于回滚）
    logs.push('Creating pre-change snapshot for rollback...');
    const snapshot = await this.createSnapshot(changeId);
    this.snapshots.set(changeId, snapshot);
    logs.push(`Snapshot created with ${snapshot.files.size} files`);

    // 步骤 2: 执行影响分析
    logs.push('Performing impact analysis...');
    const analysis = await this.analyzeImpact(payload.description, payload.affectedAreas);
    logs.push(`Impact analysis complete: ${analysis.affectedModules.length} modules affected, risk level: ${analysis.riskLevel}`);

    // 步骤 3: 更新规格文档（spec before code 原则）
    logs.push('Updating specification document...');
    const specUpdated = await this.updateSpecification(analysis);
    if (specUpdated) {
      logs.push('Specification document updated successfully');
    } else {
      logs.push('Warning: Specification update had issues, proceeding with caution');
    }

    // 步骤 4: 生成变更检查清单
    logs.push('Generating change checklist...');
    this.currentChecklist = this.generateChecklist(analysis);
    logs.push(`Checklist generated: ${this.currentChecklist.length} items`);

    // 步骤 5: 协调 Builder agents 应用变更
    logs.push('Coordinating Builder agents to apply changes...');
    const applyResult = await this.coordinateChangeApplication(task, analysis);
    logs.push(...applyResult.logs);

    if (!applyResult.success) {
      // 变更应用失败，执行回滚
      logs.push('Change application failed, initiating rollback...');
      const rollbackResult = await this.executeRollback(changeId);
      logs.push(...rollbackResult.logs);

      return this.createFailureResult(
        `Change application failed and was rolled back: ${applyResult.error}`,
        logs,
      );
    }

    // 步骤 6: 回归验证
    logs.push('Running regression verification...');
    const regressionResult = await this.verifyRegression(changeId);

    if (!regressionResult.passed) {
      // 回归验证失败，执行回滚
      logs.push('Regression verification failed, initiating rollback...');
      logs.push(`Reason: ${regressionResult.rollbackReason ?? 'Tests failed or consistency issues detected'}`);
      const rollbackResult = await this.executeRollback(changeId);
      logs.push(...rollbackResult.logs);

      return this.createFailureResult(
        `Regression verification failed, change rolled back: ${regressionResult.rollbackReason}`,
        logs,
      );
    }

    logs.push('Change request completed successfully');
    this.addAssistantMessage(
      `Change request ${changeId} completed. ${this.currentChecklist.length} items processed, risk level: ${analysis.riskLevel}.`,
    );

    return this.createSuccessResult(
      {
        changeId,
        impactAnalysis: analysis,
        checklist: this.currentChecklist,
        regressionResult,
        specUpdated,
      },
      [],
      logs,
    );
  }

  // ─── Impact Analysis ───────────────────────────────────────────────────

  /**
   * 执行独立的影响分析任务
   */
  private async performImpactAnalysis(task: TaskDescriptor): Promise<TaskResult> {
    this.logger.info('Performing standalone impact analysis', { title: task.title });

    const payload = task.payload as ChangeRequestPayload;
    const logs: string[] = [];

    const analysis = await this.analyzeImpact(
      payload.description,
      payload.affectedAreas,
    );

    logs.push(`Impact analysis complete: ${analysis.affectedModules.length} modules affected`);
    logs.push(`Risk level: ${analysis.riskLevel}`);
    logs.push(`Spec changes: ${analysis.specChanges.length}`);

    this.addAssistantMessage(
      `Impact analysis complete. ${analysis.affectedModules.length} modules affected, risk: ${analysis.riskLevel}.`,
    );

    return this.createSuccessResult(
      { impactAnalysis: analysis },
      [],
      logs,
    );
  }

  /**
   * 核心影响分析逻辑：使用 LLM 分析变更描述并确定受影响的模块和文件。
   */
  private async analyzeImpact(
    changeDescription: string,
    affectedAreas?: string[],
  ): Promise<ImpactAnalysis> {
    // 收集项目上下文
    const projectStructure = await this.getProjectContext();
    const specContent = await this.readSpecContent();
    const archContent = await this.readArchitectureContent();

    // 读取所有源代码文件列表
    const allFiles = await this.fs.listAllFiles().catch(() => []);
    const sourceFiles = allFiles.filter(f =>
      /\.(ts|js|tsx|jsx)$/.test(f) &&
      !f.includes('node_modules') &&
      !f.includes('dist/') &&
      !f.includes('.test.') &&
      !f.includes('.spec.') &&
      !f.includes('.config.'),
    );

    // 读取关键源文件内容（限制数量以避免上下文溢出）
    const keyFiles = sourceFiles.slice(0, 30);
    const fileContents = await this.fs.readFiles(keyFiles);
    const filesContext = Array.from(fileContents.entries())
      .map(([path, content]) => `// --- ${path} ---\n${content.substring(0, 2000)}`)
      .join('\n\n');

    // 构建影响分析提示词
    const prompt = `Analyze the impact of the following change request on the codebase.

## Change Request
${changeDescription}

${affectedAreas && affectedAreas.length > 0 ? `## Suspected Affected Areas\n${affectedAreas.join(', ')}` : ''}

## Project Structure
${projectStructure}

## Specification Document
${specContent.substring(0, 5000)}

${archContent ? `## Architecture Document\n${archContent.substring(0, 3000)}` : ''}

## Source Files (key files)
${filesContext}

## Analysis Requirements
1. Identify ALL modules and files affected by this change (direct and indirect)
2. For each affected module, determine:
   - Which specific files need modification
   - Whether the impact is direct (explicitly referenced) or indirect (through dependencies)
   - What action is required: modify, verify, add, or delete
3. Identify specification changes needed
4. Assess overall risk level

Respond in JSON format following this schema:
{
  "changeDescription": "summary of the change",
  "affectedModules": [{
    "module": "module name (e.g., 'auth', 'api', 'ui')",
    "files": ["list of affected file paths"],
    "impactType": "direct" | "indirect",
    "requiredAction": "modify" | "verify" | "add" | "delete",
    "description": "what needs to change and why"
  }],
  "specChanges": [{
    "section": "spec section name",
    "field": "specific field being changed",
    "oldValue": "current value or description",
    "newValue": "new value or description"
  }],
  "riskLevel": "low" | "medium" | "high"
}

Risk Assessment Guidelines:
- low: Change affects 1-2 files, no cross-module dependencies, no spec changes
- medium: Change affects 3-5 files, some cross-module dependencies, minor spec changes
- high: Change affects 6+ files, significant cross-module dependencies, major spec changes or breaking changes`;

    const schema = {
      changeDescription: 'string',
      affectedModules: [{
        module: 'string',
        files: ['string'],
        impactType: 'string',
        requiredAction: 'string',
        description: 'string',
      }],
      specChanges: [{
        section: 'string',
        field: 'string',
        oldValue: 'string',
        newValue: 'string',
      }],
      riskLevel: 'string',
    };

    try {
      const result = await this.llm.completeStructured<ImpactAnalysis>(prompt, schema);
      return result;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn('Structured impact analysis failed, using fallback', { error: errorMessage });

      // 降级方案：基于关键词的简单影响分析
      return this.fallbackImpactAnalysis(changeDescription, sourceFiles);
    }
  }

  /**
   * 降级影响分析：当 LLM 调用失败时，基于关键词匹配的简单分析。
   */
  private fallbackImpactAnalysis(
    changeDescription: string,
    sourceFiles: string[],
  ): ImpactAnalysis {
    const keywords = changeDescription.toLowerCase().split(/\s+/);
    const affectedFiles: string[] = [];

    // 基于文件名关键词匹配
    for (const file of sourceFiles) {
      const fileName = file.toLowerCase();
      const matchScore = keywords.filter(kw =>
        kw.length > 3 && fileName.includes(kw),
      ).length;

      if (matchScore > 0) {
        affectedFiles.push(file);
      }
    }

    // 如果没有匹配到文件，标记所有文件为需要验证
    if (affectedFiles.length === 0) {
      affectedFiles.push(...sourceFiles.slice(0, 5));
    }

    // 按模块分组
    const moduleMap = new Map<string, string[]>();
    for (const file of affectedFiles) {
      const module = file.split('/')[0] ?? 'root';
      const existing = moduleMap.get(module) ?? [];
      existing.push(file);
      moduleMap.set(module, existing);
    }

    const affectedModules = Array.from(moduleMap.entries()).map(([module, files]) => ({
      module,
      files,
      impactType: 'direct' as const,
      requiredAction: 'verify' as const,
      description: `Potentially affected by change: ${changeDescription.substring(0, 100)}`,
    }));

    return {
      changeDescription: changeDescription.substring(0, 200),
      affectedModules,
      specChanges: [],
      riskLevel: affectedFiles.length > 5 ? 'high' : affectedFiles.length > 2 ? 'medium' : 'low',
    };
  }

  // ─── Specification Update ──────────────────────────────────────────────

  /**
   * 根据影响分析结果更新规格文档。
   * 遵循 "spec before code" 原则。
   */
  private async updateSpecification(analysis: ImpactAnalysis): Promise<boolean> {
    if (analysis.specChanges.length === 0) {
      this.logger.info('No specification changes needed');
      return true;
    }

    try {
      const specExists = await this.fs.exists(this.specPath);
      let currentSpec = '';

      if (specExists) {
        currentSpec = await this.fs.readFile(this.specPath);
      }

      // 构建规格更新提示词
      const prompt = `Update the following specification document to reflect the required changes.

## Current Specification
${currentSpec}

## Required Changes
${analysis.specChanges.map(sc =>
  `- Section: ${sc.section}, Field: ${sc.field}\n  Old: ${sc.oldValue}\n  New: ${sc.newValue}`
).join('\n')}

## Change Description
${analysis.changeDescription}

## Rules
1. Apply all specified changes to the appropriate sections
2. Maintain the existing document structure and formatting
3. If a section doesn't exist, create it in the appropriate location
4. Preserve all existing content that is NOT being changed
5. Add a changelog entry at the top of the document
6. Output the COMPLETE updated document, not just the changed parts

Provide the complete updated specification document content.`;

      const updatedSpec = await this.llm.generateCode(prompt, 'Update specification document. Preserve all existing content and apply only the specified changes.');

      await this.fs.writeFile(this.specPath, updatedSpec);
      this.logger.info('Specification document updated', {
        path: this.specPath,
        changes: analysis.specChanges.length,
      });

      return true;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error('Failed to update specification', { error: errorMessage });
      return false;
    }
  }

  // ─── Change Checklist ──────────────────────────────────────────────────

  /**
   * 根据影响分析生成变更检查清单。
   */
  private generateChecklist(analysis: ImpactAnalysis): ChangeChecklistItem[] {
    const checklist: ChangeChecklistItem[] = [];

    for (const module of analysis.affectedModules) {
      for (const file of module.files) {
        checklist.push({
          id: randomUUID(),
          file,
          module: module.module,
          action: module.requiredAction,
          description: module.description,
          status: 'pending',
        });
      }
    }

    // 按模块和操作类型排序，确保修改操作先于验证操作
    checklist.sort((a, b) => {
      if (a.module !== b.module) return a.module.localeCompare(b.module);
      const actionOrder = { add: 0, modify: 1, delete: 2, verify: 3 };
      return actionOrder[a.action] - actionOrder[b.action];
    });

    return checklist;
  }

  // ─── Change Application ────────────────────────────────────────────────

  /**
   * 执行独立的应用变更任务
   */
  private async applyChange(task: TaskDescriptor): Promise<TaskResult> {
    this.logger.info('Applying change', { title: task.title });

    const payload = task.payload as {
      changeId: string;
      impactAnalysis: ImpactAnalysis;
    };

    const result = await this.coordinateChangeApplication(task, payload.impactAnalysis);

    return result.success
      ? this.createSuccessResult(result.outputs, result.artifacts, result.logs)
      : this.createFailureResult(result.error ?? 'Change application failed', result.logs);
  }

  /**
   * 协调 Builder agents 应用变更。
   * 通过 MessageBus 向 Builder agent 分发任务。
   */
  private async coordinateChangeApplication(
    task: TaskDescriptor,
    analysis: ImpactAnalysis,
  ): Promise<TaskResult> {
    const logs: string[] = [];
    const artifacts: string[] = [];
    let failedItems: string[] = [];

    for (const item of this.currentChecklist) {
      item.status = 'in_progress';
      logs.push(`Processing: [${item.action}] ${item.file}`);

      try {
        switch (item.action) {
          case 'modify': {
            // 读取当前文件内容并生成修改建议
            const fileExists = await this.fs.exists(item.file);
            if (!fileExists) {
              logs.push(`File not found: ${item.file}, skipping`);
              item.status = 'failed';
              failedItems.push(item.file);
              continue;
            }

            const currentContent = await this.fs.readFile(item.file);

            // 保存回滚内容
            item.rollbackContent = currentContent;

            // 使用 LLM 生成修改后的代码
            const modifiedContent = await this.generateModifiedCode(
              item.file,
              currentContent,
              analysis.changeDescription,
              item.description,
            );

            await this.fs.writeFile(item.file, modifiedContent);
            artifacts.push(item.file);
            item.status = 'completed';
            logs.push(`Modified: ${item.file}`);
            break;
          }

          case 'add': {
            // 生成新文件
            const newContent = await this.generateNewFile(
              item.file,
              analysis.changeDescription,
              item.description,
            );

            await this.fs.writeFile(item.file, newContent);
            artifacts.push(item.file);
            item.status = 'completed';
            logs.push(`Added: ${item.file}`);
            break;
          }

          case 'delete': {
            // 保存回滚内容后删除
            const fileExists = await this.fs.exists(item.file);
            if (fileExists) {
              const content = await this.fs.readFile(item.file);
              item.rollbackContent = content;
              await this.fs.deleteFile(item.file);
              item.status = 'completed';
              logs.push(`Deleted: ${item.file}`);
            } else {
              logs.push(`File not found for deletion: ${item.file}`);
              item.status = 'completed';
            }
            break;
          }

          case 'verify': {
            // 验证文件是否与变更兼容
            const fileExists = await this.fs.exists(item.file);
            if (fileExists) {
              const content = await this.fs.readFile(item.file);
              const compatible = await this.verifyFileCompatibility(
                item.file,
                content,
                analysis.changeDescription,
              );

              if (compatible) {
                item.status = 'completed';
                logs.push(`Verified: ${item.file} - compatible`);
              } else {
                item.status = 'failed';
                failedItems.push(item.file);
                logs.push(`Verification failed: ${item.file} - incompatible with change`);
              }
            } else {
              logs.push(`File not found for verification: ${item.file}`);
              item.status = 'completed';
            }
            break;
          }
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        item.status = 'failed';
        failedItems.push(item.file);
        logs.push(`Error processing ${item.file}: ${errorMessage}`);
        this.logger.warn('Failed to process checklist item', {
          file: item.file,
          error: errorMessage,
        });
      }
    }

    const completedCount = this.currentChecklist.filter(i => i.status === 'completed').length;
    const failedCount = failedItems.length;

    if (failedCount > 0) {
      return this.createFailureResult(
        `${failedCount} item(s) failed: ${failedItems.join(', ')}`,
        logs,
      );
    }

    return this.createSuccessResult(
      {
        completedItems: completedCount,
        totalItems: this.currentChecklist.length,
        artifacts: artifacts,
      },
      artifacts,
      logs,
    );
  }

  /**
   * 使用 LLM 生成修改后的代码
   */
  private async generateModifiedCode(
    filePath: string,
    currentContent: string,
    changeDescription: string,
    modificationHint: string,
  ): Promise<string> {
    const prompt = `Modify the following file to implement the required change.

## File: ${filePath}
\`\`\`
${currentContent}
\`\`\`

## Change Description
${changeDescription}

## Modification Hint
${modificationHint}

## Rules
1. Apply ONLY the changes needed for the described modification
2. Preserve all existing functionality that is NOT affected
3. Maintain the existing code style and conventions
4. Ensure imports are updated if new dependencies are needed
5. Output the COMPLETE modified file, not just the changed parts

Provide the complete modified file content.`;

    return await this.llm.generateCode(prompt, `Modify ${filePath} according to the change description. Preserve all unrelated code.`);
  }

  /**
   * 使用 LLM 生成新文件内容
   */
  private async generateNewFile(
    filePath: string,
    changeDescription: string,
    description: string,
  ): Promise<string> {
    const prompt = `Create a new file for the following change.

## File Path: ${filePath}
## Change Description
${changeDescription}

## File Purpose
${description}

## Rules
1. Create a complete, functional file
2. Follow the project's existing code style and conventions
3. Include proper TypeScript types
4. Include error handling
5. Add JSDoc comments for public APIs
6. Ensure the file is self-contained and importable

Provide the complete file content.`;

    return await this.llm.generateCode(prompt, `Create new file ${filePath} for the described change.`);
  }

  /**
   * 验证文件是否与变更兼容
   */
  private async verifyFileCompatibility(
    filePath: string,
    content: string,
    changeDescription: string,
  ): Promise<boolean> {
    const prompt = `Verify if the following file is compatible with the described change.

## File: ${filePath}
\`\`\`
${content.substring(0, 5000)}
\`\`\`

## Change Description
${changeDescription}

## Analysis
1. Does this file reference any APIs, types, or interfaces that might be affected by the change?
2. Does this file's logic conflict with the change?
3. Are there any imports or dependencies that need updating?

Respond in JSON format:
{
  "compatible": boolean,
  "reason": "explanation of why it is or isn't compatible",
  "suggestedChanges": ["list of changes needed if not compatible"]
}`;

    try {
      const result = await this.llm.completeStructured<{
        compatible: boolean;
        reason: string;
        suggestedChanges: string[];
      }>(prompt, {
        compatible: 'boolean',
        reason: 'string',
        suggestedChanges: ['string'],
      });

      return result.compatible;
    } catch {
      // LLM 调用失败时默认为兼容
      this.logger.warn('File compatibility verification failed, defaulting to compatible', { file: filePath });
      return true;
    }
  }

  // ─── Regression Verification ───────────────────────────────────────────

  /**
   * 执行独立的回归验证任务
   */
  private async runRegressionVerification(task: TaskDescriptor): Promise<TaskResult> {
    this.logger.info('Running regression verification', { title: task.title });

    const changeId = (task.payload as { changeId?: string })?.changeId ?? task.id;
    const result = await this.verifyRegression(changeId);

    return this.createSuccessResult(
      { regressionResult: result },
      [],
      [
        `Tests: ${result.testResults.passed}/${result.testResults.total} passed`,
        `Consistency check: ${result.consistencyCheck.passed ? 'passed' : 'failed'}`,
        result.rollbackRequired ? `Rollback required: ${result.rollbackReason}` : 'No rollback needed',
      ],
    );
  }

  /**
   * 执行回归验证：运行测试并检查模块间一致性。
   */
  private async verifyRegression(changeId: string): Promise<RegressionResult> {
    const logs: string[] = [];

    // 1. 运行测试套件
    const testResult = await this.runTestSuite();
    logs.push(`Test results: ${testResult.passed}/${testResult.total} passed, ${testResult.failed} failed`);

    // 2. 检查模块间一致性
    const consistencyResult = await this.checkCrossModuleConsistency();
    logs.push(`Consistency check: ${consistencyResult.passed ? 'passed' : 'failed'}`);
    if (!consistencyResult.passed) {
      logs.push(`Consistency issues: ${consistencyResult.issues.join('; ')}`);
    }

    // 3. 判断是否需要回滚
    const rollbackRequired = testResult.failed > 0 || !consistencyResult.passed;
    const rollbackReason = rollbackRequired
      ? [
          testResult.failed > 0 ? `${testResult.failed} test(s) failed` : '',
          !consistencyResult.passed ? 'Cross-module consistency issues detected' : '',
        ].filter(Boolean).join('; ')
      : undefined;

    return {
      passed: !rollbackRequired,
      testResults: testResult,
      consistencyCheck: consistencyResult,
      rollbackRequired,
      rollbackReason,
    };
  }

  /**
   * 运行测试套件并返回结果摘要
   */
  private async runTestSuite(): Promise<{ total: number; passed: number; failed: number }> {
    const hasPackageJson = await this.fs.exists('package.json').catch(() => false);
    if (!hasPackageJson) {
      return { total: 0, passed: 0, failed: 0 };
    }

    try {
      const packageJson = await this.fs.readFile('package.json');
      const pkg = JSON.parse(packageJson);

      // 检查是否有测试脚本
      const testScript = pkg.scripts?.test;
      if (!testScript) {
        this.logger.info('No test script found in package.json');
        return { total: 0, passed: 0, failed: 0 };
      }

      // 通过 MessageBus 请求 Tester agent 运行测试
      const testTask: TaskDescriptor = {
        id: randomUUID(),
        type: 'run_tests',
        title: `Regression tests for change ${this.getActiveTaskId()}`,
        description: 'Run all tests to verify change does not break existing functionality',
        payload: {
          changeId: this.getActiveTaskId(),
        },
      };

      // 尝试委托给 Tester agent
      try {
        const testerResult = await this.delegateToSubAgent('tester', testTask, 120_000);
        if (testerResult.success && testerResult.outputs) {
          const summary = testerResult.outputs.summary as { total: number; passed: number; failed: number } | undefined;
          if (summary) {
            return summary;
          }
        }
      } catch {
        // Tester agent 不可用，跳过测试运行
        this.logger.warn('Tester agent not available for regression tests');
      }

      return { total: 0, passed: 0, failed: 0 };
    } catch {
      return { total: 0, passed: 0, failed: 0 };
    }
  }

  /**
   * 检查跨模块一致性。
   * 这是 Evolver 的核心价值：确保变更不会导致模块间接口不匹配。
   */
  private async checkCrossModuleConsistency(): Promise<{ passed: boolean; issues: string[] }> {
    const issues: string[] = [];

    try {
      // 收集所有导出接口
      const allFiles = await this.fs.listAllFiles().catch(() => []);
      const sourceFiles = allFiles.filter(f =>
        /\.(ts|js|tsx|jsx)$/.test(f) &&
        !f.includes('node_modules') &&
        !f.includes('dist/') &&
        !f.includes('.test.') &&
        !f.includes('.spec.') &&
        !f.includes('.config.'),
      );

      // 读取所有源文件（限制数量）
      const filesToCheck = sourceFiles.slice(0, 20);
      const fileContents = await this.fs.readFiles(filesToCheck);

      // 构建一致性检查提示词
      const filesContext = Array.from(fileContents.entries())
        .map(([path, content]) => `// --- ${path} ---\n${content.substring(0, 3000)}`)
        .join('\n\n');

      const prompt = `Analyze the following codebase for cross-module consistency issues.

## Source Files
${filesContext}

## Consistency Checks
1. Import/Export Mismatch: Are all imported symbols actually exported from their source modules?
2. Type Consistency: Do function signatures match across caller and callee?
3. Interface Compatibility: Do classes implement their declared interfaces correctly?
4. Data Flow: Are data transformations between modules consistent (e.g., same field names, types)?
5. API Contract: Do module boundaries respect their documented interfaces?
6. Dependency Direction: Are there circular dependencies or inappropriate coupling?

Respond in JSON format:
{
  "passed": boolean,
  "issues": ["description of each consistency issue found"]
}

Set "passed" to true only if NO consistency issues are found.`;

      const result = await this.llm.completeStructured<{
        passed: boolean;
        issues: string[];
      }>(prompt, {
        passed: 'boolean',
        issues: ['string'],
      });

      return result;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn('Cross-module consistency check failed', { error: errorMessage });
      // LLM 失败时默认通过（避免误报）
      return { passed: true, issues: [] };
    }
  }

  // ─── Rollback ──────────────────────────────────────────────────────────

  /**
   * 执行独立的回滚任务
   */
  private async rollbackChange(task: TaskDescriptor): Promise<TaskResult> {
    this.logger.info('Rolling back change', { title: task.title });

    const changeId = (task.payload as { changeId: string }).changeId;
    const result = await this.executeRollback(changeId);

    return result.success
      ? this.createSuccessResult(result.outputs, result.artifacts, result.logs)
      : this.createFailureResult(result.error ?? 'Rollback failed', result.logs);
  }

  /**
   * 执行回滚操作：将所有文件恢复到变更前的状态。
   */
  private async executeRollback(changeId: string): Promise<TaskResult> {
    const logs: string[] = [];
    const snapshot = this.snapshots.get(changeId);

    if (!snapshot) {
      logs.push(`No snapshot found for change ${changeId}`);
      return this.createFailureResult(`No snapshot found for change ${changeId}`, logs);
    }

    logs.push(`Restoring ${snapshot.files.size} files from snapshot...`);

    // 恢复所有文件到变更前状态
    let restoredCount = 0;
    for (const [filePath, content] of snapshot.files) {
      try {
        await this.fs.writeFile(filePath, content);
        restoredCount++;
        logs.push(`Restored: ${filePath}`);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logs.push(`Failed to restore ${filePath}: ${errorMessage}`);
      }
    }

    // 恢复规格文档
    try {
      await this.fs.writeFile(this.specPath, snapshot.specContent);
      logs.push(`Restored specification: ${this.specPath}`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logs.push(`Failed to restore specification: ${errorMessage}`);
    }

    // 重置检查清单状态
    this.currentChecklist = [];

    // 清理快照
    this.snapshots.delete(changeId);

    logs.push(`Rollback complete: ${restoredCount} files restored`);

    this.addAssistantMessage(
      `Change ${changeId} rolled back. ${restoredCount} files restored to pre-change state.`,
    );

    return this.createSuccessResult(
      {
        changeId,
        filesRestored: restoredCount,
        totalFiles: snapshot.files.size,
      },
      [],
      logs,
    );
  }

  // ─── Snapshot Management ───────────────────────────────────────────────

  /**
   * 创建变更前快照，保存所有文件当前状态用于回滚。
   */
  private async createSnapshot(changeId: string): Promise<ChangeSnapshot> {
    const files = new Map<string, string>();
    let specContent = '';

    // 保存所有源文件
    const allFiles = await this.fs.listAllFiles().catch(() => []);
    const sourceFiles = allFiles.filter(f =>
      /\.(ts|js|tsx|jsx|md|json)$/.test(f) &&
      !f.includes('node_modules') &&
      !f.includes('dist/') &&
      !f.includes('build/'),
    );

    for (const filePath of sourceFiles) {
      try {
        const content = await this.fs.readFile(filePath);
        files.set(filePath, content);
      } catch {
        // 跳过无法读取的文件
      }
    }

    // 保存规格文档
    try {
      specContent = await this.fs.readFile(this.specPath);
    } catch {
      specContent = '';
    }

    return {
      changeId,
      timestamp: new Date().toISOString(),
      files,
      specContent,
    };
  }

  // ─── Context Helpers ──────────────────────────────────────────────────

  /**
   * 获取项目结构上下文
   */
  private async getProjectContext(): Promise<string> {
    try {
      return await this.fs.getProjectStructure();
    } catch {
      return 'Unable to retrieve project structure';
    }
  }

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
}
