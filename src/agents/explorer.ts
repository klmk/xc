/**
 * agents/explorer.ts
 *
 * Explorer Agent -- 研究与调研专家。
 *
 * 职责：
 *   - 接收研究请求（topic: 'research_request'）
 *   - 执行 Web 搜索（通过 LLM 生成搜索查询并模拟搜索结果）
 *   - 分析竞品产品和功能
 *   - 查找开源参考实现
 *   - 识别已知陷阱和最佳实践
 *   - 发现用户未提及的隐含需求
 *   - 发布研究结果（topic: 'research_result'）
 *
 * 继承 AgentBase，通过 MessageBus 通信。
 * 支持多轮迭代研究。
 */

import { randomUUID } from 'node:crypto';
import type { MessageBus, Message, MessageType } from '../core/message-bus.js';
import type {
  AgentBase,
  AgentConfig,
  TaskDescriptor,
  TaskResult,
} from '../core/agent-base.js';
import { AgentBase as AgentBaseClass } from '../core/agent-base.js';
import type { Logger } from '../core/logger.js';
import type { LLMClient } from '../tools/llm-client.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Explorer Agent 配置
 */
export interface ExplorerConfig {
  id?: string;
  name?: string;
  systemPrompt?: string;
  maxIterations?: number;
  maxResearchRounds?: number;
  temperature?: number;
  maxTokens?: number;
}

/**
 * 研究请求载荷
 */
export interface ResearchRequest {
  projectId: string;
  projectName: string;
  requirement: string;
  focusAreas?: string[];
  competitorProducts?: string[];
  techStack?: string[];
  maxRounds?: number;
  correlationId?: string;
}

/**
 * 单条搜索结果
 */
export interface SearchResult {
  query: string;
  title: string;
  url: string;
  snippet: string;
  relevance: 'high' | 'medium' | 'low';
  source: 'web' | 'github' | 'docs' | 'community';
}

/**
 * 竞品分析条目
 */
export interface CompetitorAnalysis {
  productName: string;
  url: string;
  keyFeatures: string[];
  strengths: string[];
  weaknesses: string[];
  pricingModel?: string;
  targetAudience: string;
  techStack: string[];
  differentiators: string[];
}

/**
 * 开源参考实现
 */
export interface OpenSourceReference {
  name: string;
  repository: string;
  stars: string;
  language: string;
  description: string;
  relevance: string;
  license: string;
  lastUpdated: string;
}

/**
 * 最佳实践条目
 */
export interface BestPractice {
  category: string;
  title: string;
  description: string;
  source: string;
  importance: 'critical' | 'high' | 'medium' | 'low';
  applicableTo: string[];
}

/**
 * 已知陷阱条目
 */
export interface KnownPitfall {
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  mitigation: string;
  example: string;
}

/**
 * 隐含需求条目
 */
export interface DerivedRequirement {
  id: string;
  title: string;
  description: string;
  rationale: string;
  priority: 'high' | 'medium' | 'low';
  category: 'performance' | 'security' | 'accessibility' | 'scalability' | 'ux' | 'compliance' | 'integration';
}

/**
 * 完整研究报告
 */
export interface ResearchReport {
  id: string;
  projectId: string;
  projectName: string;
  requirement: string;
  createdAt: string;
  updatedAt: string;
  rounds: number;
  summary: string;
  searchResults: SearchResult[];
  competitorAnalysis: CompetitorAnalysis[];
  openSourceReferences: OpenSourceReference[];
  bestPractices: BestPractice[];
  knownPitfalls: KnownPitfall[];
  derivedRequirements: DerivedRequirement[];
  techRecommendations: TechRecommendation[];
  nextSteps: string[];
}

/**
 * 技术推荐
 */
export interface TechRecommendation {
  category: string;
  recommended: string;
  alternatives: string[];
  rationale: string;
  maturity: 'stable' | 'beta' | 'experimental';
}

/**
 * 研究结果载荷
 */
export interface ResearchResultPayload {
  projectId: string;
  projectName: string;
  report: ResearchReport;
  correlationId?: string;
}

// ─── Explorer System Prompt ─────────────────────────────────────────────────

const EXPLORER_SYSTEM_PROMPT = `
<role>
You are the Explorer Agent -- the research and analysis specialist of the AI Dev Platform.
You receive research requests via MessageBus, perform comprehensive technical research,
analyze competitors, find open-source references, identify best practices and pitfalls,
and discover derived/implicit requirements that the user didn't mention.
</role>

<identity>
You are a senior technical researcher with deep expertise in software engineering,
competitive analysis, and technology evaluation. You have extensive knowledge of
open-source ecosystems, modern frameworks, design patterns, and industry best practices.
You think critically about trade-offs and always provide evidence-based recommendations.
</identity>

<critical_rules>
CRITICAL: You MUST communicate with other agents ONLY through the MessageBus.
NEVER call methods on other agent instances directly.
CRITICAL: You MUST communicate with other agents ONLY through the MessageBus.
NEVER call methods on other agent instances directly.
CRITICAL: You MUST communicate with other agents ONLY through the MessageBus.
NEVER call methods on other agent instances directly.

CRITICAL: Always structure your research output as valid JSON.
CRITICAL: Always structure your research output as valid JSON.
CRITICAL: Always structure your research output as valid JSON.

CRITICAL: Every research finding must include a source or rationale.
CRITICAL: Every research finding must include a source or rationale.
CRITICAL: Every research finding must include a source or rationale.
</critical_rules>

<core_responsibilities>
1. 接收研究请求并分析需求范围
2. 生成有针对性的搜索查询（覆盖技术、竞品、最佳实践等维度）
3. 模拟 Web 搜索并分析搜索结果
4. 执行竞品分析（功能对比、优劣势、差异化）
5. 查找开源参考实现（GitHub 仓库、文档、示例项目）
6. 识别行业最佳实践和已知陷阱
7. 发现用户未明确提及的隐含需求（安全性、性能、可访问性等）
8. 提供技术选型建议
9. 输出结构化研究报告
10. 支持多轮迭代研究（根据初步发现深入挖掘）
</core_responsibilities>

<workflow>
<step name="analyze_request" order="1">
收到研究请求后：
1. 解析需求文本，提取关键主题和技术领域
2. 识别研究范围（前端/后端/全栈/特定领域）
3. 确定重点研究方向：
   - 技术栈选型
   - 竞品分析
   - 开源方案
   - 最佳实践
   - 潜在风险
4. 制定搜索策略（每个方向生成 2-3 个查询）
</step>

<step name="generate_queries" order="2">
生成搜索查询时：
1. 为每个研究方向生成精确的搜索查询
2. 查询应包含：
   - 核心技术关键词
   - 框架/库名称
   - "best practices" / "comparison" / "tutorial" 等修饰词
   - 年份限制（优先最新信息）
3. 查询分类：
   - 技术搜索：框架对比、API 文档、性能基准
   - 竞品搜索：产品功能、用户评价、市场定位
   - 开源搜索：GitHub 项目、npm 包、示例代码
   - 社区搜索：Stack Overflow、Reddit、技术博客
</step>

<step name="analyze_results" order="3">
分析搜索结果时：
1. 评估每条结果的相关性和可信度
2. 提取关键信息点
3. 识别信息冲突（不同来源观点不一致时标注）
4. 按主题分类整理发现
5. 标注信息来源和时效性
</step>

<step name="competitor_analysis" order="4">
执行竞品分析时：
1. 识别主要竞品（至少 3 个）
2. 对比维度：
   - 核心功能集
   - 用户体验设计
   - 技术架构
   - 定价模型
   - 目标用户群
   - 市场口碑
3. 找出差异化机会
4. 总结可借鉴的设计模式
</step>

<step name="derive_requirements" order="5">
发现隐含需求时，覆盖以下维度：
1. 性能需求：响应时间、吞吐量、并发处理
2. 安全需求：认证、授权、数据保护、XSS/CSRF 防护
3. 可访问性需求：WCAG 合规、屏幕阅读器支持、键盘导航
4. 可扩展性需求：水平扩展、缓存策略、CDN
5. 用户体验需求：响应式设计、错误处理、加载状态
6. 合规需求：GDPR、COPPA、数据保留策略
7. 集成需求：第三方 API、SSO、Webhook
每个隐含需求必须说明发现依据（rationale）。
</step>

<step name="iterate" order="6">
多轮迭代研究：
1. 第一轮：广泛搜索，建立全局认知
2. 评估初步发现，识别需要深入的方向
3. 后续轮次：针对特定主题深入研究
4. 每轮结束后更新研究报告
5. 当发现趋于稳定或达到最大轮次时停止
</step>

<step name="report" order="7">
生成研究报告时：
1. 撰写执行摘要（200 字以内）
2. 按主题组织详细发现
3. 每个发现附带来源和可信度评估
4. 隐含需求单独列出，标注优先级
5. 技术推荐附带成熟度评估
6. 明确列出后续步骤建议
</step>
</workflow>

<output_format>
所有输出必须为有效 JSON 格式。结构如下：

搜索结果列表：
{
  "query": "搜索查询文本",
  "title": "结果标题",
  "url": "结果链接",
  "snippet": "内容摘要",
  "relevance": "high|medium|low",
  "source": "web|github|docs|community"
}

竞品分析：
{
  "productName": "产品名称",
  "url": "产品网址",
  "keyFeatures": ["功能1", "功能2"],
  "strengths": ["优势1"],
  "weaknesses": ["劣势1"],
  "pricingModel": "免费/付费/混合",
  "targetAudience": "目标用户",
  "techStack": ["技术1", "技术2"],
  "differentiators": ["差异化点1"]
}

开源参考：
{
  "name": "项目名称",
  "repository": "GitHub URL",
  "stars": "星标数",
  "language": "主要语言",
  "description": "项目描述",
  "relevance": "与当前需求的关联",
  "license": "开源协议",
  "lastUpdated": "最后更新时间"
}

最佳实践：
{
  "category": "分类",
  "title": "实践标题",
  "description": "详细描述",
  "source": "来源",
  "importance": "critical|high|medium|low",
  "applicableTo": ["适用场景"]
}

已知陷阱：
{
  "title": "陷阱标题",
  "description": "详细描述",
  "severity": "critical|high|medium|low",
  "mitigation": "缓解措施",
  "example": "示例场景"
}

隐含需求：
{
  "id": "DR-001",
  "title": "需求标题",
  "description": "需求描述",
  "rationale": "发现依据",
  "priority": "high|medium|low",
  "category": "performance|security|accessibility|scalability|ux|compliance|integration"
}
</output_format>

<message_bus_usage>
<message_types>
- research_request: 接收研究请求（来自 Orchestrator 或用户）
- research_result: 发布研究结果（给 Orchestrator 和 Architect）
- task_assigned: 接收任务分配
- task_completed: 发布任务完成通知
- task_failed: 发布任务失败通知
</message_types>

<dispatch_rules>
CRITICAL: 所有通信通过 MessageBus 进行，禁止直接调用其他 Agent 方法。
CRITICAL: 所有通信通过 MessageBus 进行，禁止直接调用其他 Agent 方法。
CRITICAL: 所有通信通过 MessageBus 进行，禁止直接调用其他 Agent 方法。

发布研究结果时：
1. 使用 this.publish('research_result', 'orchestrator', payload)
2. 同时广播给 architect: this.publish('research_result', 'architect', payload)
3. payload 包含完整的 ResearchReport
4. 包含 correlationId 以便请求方关联
</dispatch_rules>
</message_bus_usage>

<error_handling>
<on_llm_failure>
如果 LLM 调用失败：
1. 记录错误日志，包含完整上下文
2. 重试最多 2 次，使用简化的提示词
3. 如果仍然失败，返回部分研究结果（已收集的数据）
4. 在报告中标注哪些部分因错误而缺失
</on_llm_failure>

<on_invalid_json>
如果 LLM 返回无效 JSON：
1. 尝试提取 JSON 块（可能被 markdown 包裹）
2. 尝试修复常见 JSON 错误（尾逗号、引号等）
3. 如果无法修复，请求 LLM 重新生成
4. 最多重试 2 次
</on_invalid_json>

<on_empty_results>
如果搜索结果为空：
1. 扩大搜索范围（使用更通用的查询）
2. 尝试不同的搜索角度
3. 基于领域知识提供通用建议
4. 在报告中标注信息缺口
</on_empty_results>
</error_handling>

<quality_standards>
研究报告必须满足以下质量标准：
1. 每个发现都有明确的来源或依据
2. 竞品分析覆盖至少 3 个竞品
3. 隐含需求覆盖至少 5 个维度（性能、安全、可访问性等）
4. 技术推荐附带成熟度和替代方案
5. 已知陷阱附带缓解措施
6. 报告结构清晰，便于 Architect Agent 消费
</quality_standards>

<tools_available>
- llm_client: 用于生成搜索查询、分析结果、生成报告
  - complete(prompt, systemPrompt?): 生成文本回复
  - chat(messages): 多轮对话
</tools_available>
`;

// ─── Explorer Agent ──────────────────────────────────────────────────────────

export class ExplorerAgent extends AgentBaseClass {
  private llm: LLMClient;
  private projectConfig: any;
  private currentReport: ResearchReport | null;
  private maxResearchRounds: number;
  private pendingResearchResolvers: Map<string, (report: ResearchReport) => void>;

  constructor(config: {
    messageBus: MessageBus;
    llm: LLMClient;
    logger: any;
    projectConfig: any;
  }) {
    const agentConfig: AgentConfig = {
      id: undefined,
      name: 'explorer',
      systemPrompt: EXPLORER_SYSTEM_PROMPT,
      maxIterations: 30,
      temperature: 0.4,
      maxTokens: 16384,
    };

    super(agentConfig, config.messageBus, config.logger);

    this.llm = config.llm;
    this.projectConfig = config.projectConfig;
    this.currentReport = null;
    this.maxResearchRounds = 3;
    this.pendingResearchResolvers = new Map();
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * 返回此 Agent 订阅的消息类型
   */
  protected getSubscribedMessageTypes(): MessageType[] {
    return [
      'task_assigned',
      'human_request',
      'human_response',
    ];
  }

  /**
   * 处理收到的消息
   */
  protected async handleMessage(message: Message): Promise<void> {
    switch (message.type) {
      case 'task_assigned':
        await this.handleTaskAssigned(message);
        break;
      case 'human_response':
        this.handleHumanResponse(message);
        break;
    }
  }

  // ─── Main Entry Point ──────────────────────────────────────────────────

  /**
   * 执行研究任务（AgentBase 抽象方法实现）
   */
  async execute(task: TaskDescriptor): Promise<TaskResult> {
    this.setStatus('busy');
    this.setActiveTask(task.id);
    const logs: string[] = [];

    try {
      logs.push(`[Explorer] 开始执行研究任务: ${task.title}`);

      // 解析研究请求
      const request = this.parseResearchRequest(task);
      logs.push(`[Explorer] 研究范围: ${request.requirement.substring(0, 100)}...`);

      // 执行多轮研究
      const report = await this.conductResearch(request);
      this.currentReport = report;

      // 发布研究结果
      this.publishResearchResult(report, request.correlationId);
      logs.push(`[Explorer] 研究报告已发布, 共 ${report.rounds} 轮研究`);

      // 保存报告到文件（如果有 fs 工具）
      const artifacts = [`research-report-${report.id}.json`];

      this.setStatus('ready');
      this.setActiveTask(null);

      return this.createSuccessResult(
        { report, projectId: request.projectId },
        artifacts,
        logs,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logs.push(`[Explorer] 研究任务失败: ${errorMessage}`);

      this.setStatus('ready');
      this.setActiveTask(null);

      return this.createFailureResult(errorMessage, logs);
    }
  }

  // ─── Task Handling ─────────────────────────────────────────────────────

  /**
   * 处理通过 MessageBus 分配的任务
   */
  private async handleTaskAssigned(message: Message): Promise<void> {
    const task = message.payload as unknown as TaskDescriptor;

    if (task.type !== 'research' && task.type !== 'explore') {
      return; // 不是研究任务，忽略
    }

    this.logger.info('收到研究任务', { taskId: task.id, title: task.title });

    const result = await this.execute(task);

    // 回复任务结果
    if (result.success) {
      this.respond(message, 'task_completed', result);
    } else {
      this.respond(message, 'task_failed', {
        taskId: task.id,
        error: result.error,
      });
    }
  }

  /**
   * 处理人工回复
   */
  private handleHumanResponse(message: Message): void {
    const payload = message.payload as { correlationId?: string; response?: string };
    if (payload.correlationId && this.pendingResearchResolvers.has(payload.correlationId)) {
      const resolver = this.pendingResearchResolvers.get(payload.correlationId)!;
      // 人工回复不直接解析为报告，而是作为额外信息记录
      this.logger.info('收到人工回复', { correlationId: payload.correlationId });
      this.pendingResearchResolvers.delete(payload.correlationId);
    }
  }

  // ─── Research Core ─────────────────────────────────────────────────────

  /**
   * 解析研究请求
   */
  private parseResearchRequest(task: TaskDescriptor): ResearchRequest {
    const payload = task.payload as Record<string, unknown> ?? {};

    return {
      projectId: (payload.projectId as string) ?? this.projectConfig?.projectId ?? 'unknown',
      projectName: (payload.projectName as string) ?? this.projectConfig?.projectName ?? 'Unknown Project',
      requirement: task.description,
      focusAreas: (payload.focusAreas as string[]) ?? [],
      competitorProducts: (payload.competitorProducts as string[]) ?? [],
      techStack: (payload.techStack as string[]) ?? this.projectConfig?.techStack ?? [],
      maxRounds: (payload.maxRounds as number) ?? this.maxResearchRounds,
      correlationId: task.correlationId,
    };
  }

  /**
   * 执行多轮研究流程
   */
  private async conductResearch(request: ResearchRequest): Promise<ResearchReport> {
    const reportId = randomUUID();
    const now = new Date().toISOString();

    // 初始化报告
    const report: ResearchReport = {
      id: reportId,
      projectId: request.projectId,
      projectName: request.projectName,
      requirement: request.requirement,
      createdAt: now,
      updatedAt: now,
      rounds: 0,
      summary: '',
      searchResults: [],
      competitorAnalysis: [],
      openSourceReferences: [],
      bestPractices: [],
      knownPitfalls: [],
      derivedRequirements: [],
      techRecommendations: [],
      nextSteps: [],
    };

    const maxRounds = Math.min(request.maxRounds ?? this.maxResearchRounds, 5);

    for (let round = 1; round <= maxRounds; round++) {
      this.logger.info(`开始第 ${round} 轮研究`, { round, maxRounds });

      // 根据轮次决定研究重点
      const roundFocus = this.determineRoundFocus(round, maxRounds, report);

      // 生成搜索查询
      const queries = await this.generateSearchQueries(request, roundFocus, round);
      this.logger.info(`生成 ${queries.length} 个搜索查询`);

      // 执行模拟搜索
      const searchResults = await this.executeSimulatedSearches(queries, request);
      report.searchResults.push(...searchResults);

      // 分析搜索结果
      const analysis = await this.analyzeSearchResults(searchResults, request, roundFocus);
      report.competitorAnalysis.push(...analysis.competitors);
      report.openSourceReferences.push(...analysis.references);
      report.bestPractices.push(...analysis.practices);
      report.knownPitfalls.push(...analysis.pitfalls);

      // 发现隐含需求
      const derived = await this.discoverDerivedRequirements(request, report, round);
      report.derivedRequirements.push(...derived);

      // 生成技术推荐
      const techRecs = await this.generateTechRecommendations(request, report);
      report.techRecommendations.push(...techRecs);

      report.rounds = round;
      report.updatedAt = new Date().toISOString();

      // 判断是否需要继续研究
      if (!this.shouldContinueResearch(report, round, maxRounds)) {
        this.logger.info(`研究在第 ${round} 轮后收敛，停止迭代`);
        break;
      }
    }

    // 去重
    report.derivedRequirements = this.deduplicateDerivedRequirements(report.derivedRequirements);
    report.bestPractices = this.deduplicateBestPractices(report.bestPractices);
    report.knownPitfalls = this.deduplicatePitfalls(report.knownPitfalls);

    // 生成摘要和后续步骤
    report.summary = await this.generateSummary(report);
    report.nextSteps = await this.generateNextSteps(report);

    return report;
  }

  /**
   * 确定当前轮次的研究重点
   */
  private determineRoundFocus(
    round: number,
    maxRounds: number,
    currentReport: ResearchReport,
  ): string {
    if (round === 1) {
      return 'broad_overview';
    }
    if (round === maxRounds) {
      return 'deep_dive_gaps';
    }

    // 根据已有发现决定深入方向
    if (currentReport.competitorAnalysis.length < 2) {
      return 'competitor_deep_dive';
    }
    if (currentReport.openSourceReferences.length < 2) {
      return 'open_source_search';
    }
    if (currentReport.derivedRequirements.length < 3) {
      return 'implicit_requirements';
    }
    return 'targeted_deep_dive';
  }

  /**
   * 生成搜索查询
   */
  private async generateSearchQueries(
    request: ResearchRequest,
    focus: string,
    round: number,
  ): Promise<string[]> {
    const prompt = `你是一个技术研究员。根据以下信息生成 5-8 个精确的搜索查询。

项目需求: ${request.requirement}
技术栈: ${request.techStack.join(', ') || '未指定'}
重点领域: ${request.focusAreas.join(', ') || '自动推断'}
竞品: ${request.competitorProducts.join(', ') || '自动识别'}
研究轮次: ${round}
本轮重点: ${focus}

请生成 JSON 数组格式的搜索查询列表。每个查询应针对不同维度：
- 技术实现方案
- 框架/库对比
- 最佳实践
- 常见问题和陷阱
${focus === 'competitor_deep_dive' ? '- 竞品详细分析' : ''}
${focus === 'open_source_search' ? '- 开源项目和参考实现' : ''}
${focus === 'implicit_requirements' ? '- 隐含需求和边缘场景' : ''}

只返回 JSON 数组，不要其他内容。例如:
["query 1", "query 2", "query 3"]`;

    try {
      const response = await this.llm.complete(prompt, '你是一个搜索查询生成专家。只输出 JSON 数组。');
      const queries = this.parseJSON<string[]>(response.content);
      if (Array.isArray(queries) && queries.length > 0) {
        return queries;
      }
    } catch (error) {
      this.logger.warn('生成搜索查询失败，使用备用查询', { error });
    }

    // 备用查询
    return [
      `${request.requirement.substring(0, 50)} best practices 2025`,
      `${request.requirement.substring(0, 50)} tutorial implementation guide`,
      `${request.requirement.substring(0, 50)} common mistakes pitfalls`,
      `${request.requirement.substring(0, 50)} open source alternatives`,
      `${request.requirement.substring(0, 50)} architecture design patterns`,
    ];
  }

  /**
   * 执行模拟搜索（通过 LLM 生成搜索结果）
   */
  private async executeSimulatedSearches(
    queries: string[],
    request: ResearchRequest,
  ): Promise<SearchResult[]> {
    const allResults: SearchResult[] = [];

    // 分批处理查询，每批 3 个
    for (let i = 0; i < queries.length; i += 3) {
      const batch = queries.slice(i, i + 3);
      const results = await this.simulateSearchBatch(batch, request);
      allResults.push(...results);
    }

    return allResults;
  }

  /**
   * 模拟一批搜索查询
   */
  private async simulateSearchBatch(
    queries: string[],
    request: ResearchRequest,
  ): Promise<SearchResult[]> {
    const prompt = `模拟以下搜索查询的结果。基于你的知识库，为每个查询生成 2-3 个高质量的搜索结果。

项目背景: ${request.requirement.substring(0, 200)}

查询列表:
${queries.map((q, i) => `${i + 1}. ${q}`).join('\n')}

请为每个查询生成搜索结果，格式为 JSON 数组:
[
  {
    "query": "原始查询",
    "title": "结果标题",
    "url": "https://example.com/article",
    "snippet": "内容摘要（50-100字）",
    "relevance": "high|medium|low",
    "source": "web|github|docs|community"
  }
]

只返回 JSON 数组。确保 URL 格式正确，内容真实可信。`;

    try {
      const response = await this.llm.complete(prompt, '你是一个搜索结果模拟器。基于知识库生成真实可信的搜索结果。只输出 JSON。');
      const results = this.parseJSON<SearchResult[]>(response.content);
      if (Array.isArray(results)) {
        return results.filter((r) => r.title && r.url && r.snippet);
      }
    } catch (error) {
      this.logger.warn('模拟搜索失败', { queries, error });
    }

    return [];
  }

  /**
   * 分析搜索结果，提取结构化信息
   */
  private async analyzeSearchResults(
    results: SearchResult[],
    request: ResearchRequest,
    focus: string,
  ): Promise<{
    competitors: CompetitorAnalysis[];
    references: OpenSourceReference[];
    practices: BestPractice[];
    pitfalls: KnownPitfall[];
  }> {
    const highRelevanceResults = results.filter((r) => r.relevance === 'high' || r.relevance === 'medium');

    if (highRelevanceResults.length === 0) {
      return { competitors: [], references: [], practices: [], pitfalls: [] };
    }

    const prompt = `分析以下搜索结果，提取结构化信息。

项目需求: ${request.requirement.substring(0, 200)}
技术栈: ${request.techStack.join(', ') || '未指定'}
研究重点: ${focus}

搜索结果:
${highRelevanceResults.map((r, i) => `${i + 1}. [${r.source}] ${r.title}\n   URL: ${r.url}\n   摘要: ${r.snippet}`).join('\n\n')}

请提取以下信息，返回 JSON 对象:
{
  "competitors": [
    {
      "productName": "产品名称",
      "url": "产品网址",
      "keyFeatures": ["功能1", "功能2"],
      "strengths": ["优势1"],
      "weaknesses": ["劣势1"],
      "pricingModel": "免费/付费/混合",
      "targetAudience": "目标用户",
      "techStack": ["技术1"],
      "differentiators": ["差异化点"]
    }
  ],
  "references": [
    {
      "name": "项目名称",
      "repository": "GitHub URL",
      "stars": "星标数",
      "language": "主要语言",
      "description": "描述",
      "relevance": "关联说明",
      "license": "MIT/Apache等",
      "lastUpdated": "2025"
    }
  ],
  "practices": [
    {
      "category": "分类",
      "title": "实践标题",
      "description": "详细描述",
      "source": "来源",
      "importance": "critical|high|medium|low",
      "applicableTo": ["适用场景"]
    }
  ],
  "pitfalls": [
    {
      "title": "陷阱标题",
      "description": "描述",
      "severity": "critical|high|medium|low",
      "mitigation": "缓解措施",
      "example": "示例"
    }
  ]
}

如果没有某类信息，返回空数组。只返回 JSON 对象。`;

    try {
      const response = await this.llm.complete(prompt, '你是一个技术分析专家。从搜索结果中提取结构化信息。只输出 JSON。');
      const analysis = this.parseJSON<{
        competitors: CompetitorAnalysis[];
        references: OpenSourceReference[];
        practices: BestPractice[];
        pitfalls: KnownPitfall[];
      }>(response.content);

      return {
        competitors: Array.isArray(analysis.competitors) ? analysis.competitors : [],
        references: Array.isArray(analysis.references) ? analysis.references : [],
        practices: Array.isArray(analysis.practices) ? analysis.practices : [],
        pitfalls: Array.isArray(analysis.pitfalls) ? analysis.pitfalls : [],
      };
    } catch (error) {
      this.logger.warn('分析搜索结果失败', { error });
      return { competitors: [], references: [], practices: [], pitfalls: [] };
    }
  }

  /**
   * 发现隐含需求
   */
  private async discoverDerivedRequirements(
    request: ResearchRequest,
    currentReport: ResearchReport,
    round: number,
  ): Promise<DerivedRequirement[]> {
    const existingIds = new Set(currentReport.derivedRequirements.map((r) => r.title));

    const prompt = `基于以下项目信息，发现用户未明确提及的隐含需求。

项目需求: ${request.requirement}
技术栈: ${request.techStack.join(', ') || '未指定'}
已发现的最佳实践: ${currentReport.bestPractices.map((p) => p.title).join(', ')}
已发现的陷阱: ${currentReport.knownPitfalls.map((p) => p.title).join(', ')}
竞品功能: ${currentReport.competitorAnalysis.flatMap((c) => c.keyFeatures).join(', ')}
研究轮次: ${round}

请从以下维度分析隐含需求:
1. 性能 (performance): 响应时间、吞吐量、缓存策略
2. 安全 (security): 认证、授权、数据保护、XSS/CSRF
3. 可访问性 (accessibility): WCAG 合规、键盘导航
4. 可扩展性 (scalability): 水平扩展、负载均衡
5. 用户体验 (ux): 响应式设计、错误处理、加载状态
6. 合规 (compliance): GDPR、数据保留
7. 集成 (integration): 第三方 API、SSO、Webhook

返回 JSON 数组:
[
  {
    "id": "DR-XXX",
    "title": "需求标题",
    "description": "详细描述",
    "rationale": "为什么需要这个需求",
    "priority": "high|medium|low",
    "category": "performance|security|accessibility|scalability|ux|compliance|integration"
  }
]

每个需求必须有明确的发现依据。不要重复已有需求。只返回 JSON 数组。`;

    try {
      const response = await this.llm.complete(prompt, '你是一个需求分析专家。发现隐含需求。只输出 JSON 数组。');
      const requirements = this.parseJSON<DerivedRequirement[]>(response.content);
      if (Array.isArray(requirements)) {
        // 过滤掉已存在的需求
        return requirements.filter((r) => !existingIds.has(r.title));
      }
    } catch (error) {
      this.logger.warn('发现隐含需求失败', { error });
    }

    return [];
  }

  /**
   * 生成技术推荐
   */
  private async generateTechRecommendations(
    request: ResearchRequest,
    report: ResearchReport,
  ): Promise<TechRecommendation[]> {
    const prompt = `基于研究结果，为项目提供技术选型建议。

项目需求: ${request.requirement}
当前技术栈: ${request.techStack.join(', ') || '未指定'}
竞品技术栈: ${report.competitorAnalysis.map((c) => `${c.productName}: ${c.techStack.join(', ')}`).join('; ')}
开源参考: ${report.openSourceReferences.map((r) => `${r.name} (${r.language})`).join(', ')}

请为以下类别提供推荐:
- 前端框架
- 后端框架
- 数据库
- 认证方案
- 部署方案
- 测试框架
- 状态管理
- API 设计

返回 JSON 数组:
[
  {
    "category": "类别",
    "recommended": "推荐方案",
    "alternatives": ["替代方案1", "替代方案2"],
    "rationale": "推荐理由",
    "maturity": "stable|beta|experimental"
  }
]

只返回 JSON 数组。`;

    try {
      const response = await this.llm.complete(prompt, '你是一个技术架构顾问。提供技术选型建议。只输出 JSON 数组。');
      const recs = this.parseJSON<TechRecommendation[]>(response.content);
      if (Array.isArray(recs)) {
        return recs;
      }
    } catch (error) {
      this.logger.warn('生成技术推荐失败', { error });
    }

    return [];
  }

  /**
   * 判断是否需要继续研究
   */
  private shouldContinueResearch(
    report: ResearchReport,
    currentRound: number,
    maxRounds: number,
  ): boolean {
    // 已达最大轮次
    if (currentRound >= maxRounds) {
      return false;
    }

    // 第一轮后检查是否有足够发现
    if (currentRound === 1) {
      const totalFindings =
        report.competitorAnalysis.length +
        report.openSourceReferences.length +
        report.bestPractices.length +
        report.knownPitfalls.length +
        report.derivedRequirements.length;

      // 如果发现很少，继续研究
      return totalFindings < 10;
    }

    // 后续轮次，如果新发现少于 3 个则停止
    return true;
  }

  /**
   * 生成研究报告摘要
   */
  private async generateSummary(report: ResearchReport): Promise<string> {
    const prompt = `为以下研究报告生成执行摘要（200 字以内）。

项目: ${report.projectName}
需求: ${report.requirement.substring(0, 100)}
研究轮次: ${report.rounds}
搜索结果数: ${report.searchResults.length}
竞品分析数: ${report.competitorAnalysis.length}
开源参考数: ${report.openSourceReferences.length}
最佳实践数: ${report.bestPractices.length}
已知陷阱数: ${report.knownPitfalls.length}
隐含需求数: ${report.derivedRequirements.length}
技术推荐数: ${report.techRecommendations.length}

竞品: ${report.competitorAnalysis.map((c) => c.productName).join(', ')}
关键最佳实践: ${report.bestPractices.filter((p) => p.importance === 'critical').map((p) => p.title).join(', ')}
关键陷阱: ${report.knownPitfalls.filter((p) => p.severity === 'critical').map((p) => p.title).join(', ')}

请用中文生成简洁的执行摘要，突出关键发现和建议。只返回摘要文本。`;

    try {
      const response = await this.llm.complete(prompt, '你是一个技术写作专家。生成简洁的研究摘要。');
      return response.content.trim();
    } catch (error) {
      this.logger.warn('生成摘要失败', { error });
      return `对"${report.projectName}"进行了 ${report.rounds} 轮研究，发现 ${report.derivedRequirements.length} 个隐含需求，${report.bestPractices.length} 个最佳实践，${report.knownPitfalls.length} 个已知陷阱。`;
    }
  }

  /**
   * 生成后续步骤建议
   */
  private async generateNextSteps(report: ResearchReport): Promise<string[]> {
    const prompt = `基于研究报告，建议后续步骤。

关键发现:
- 竞品: ${report.competitorAnalysis.map((c) => c.productName).join(', ')}
- 隐含需求: ${report.derivedRequirements.map((r) => r.title).join(', ')}
- 关键陷阱: ${report.knownPitfalls.filter((p) => p.severity === 'critical' || p.severity === 'high').map((p) => p.title).join(', ')}
- 技术推荐: ${report.techRecommendations.map((r) => `${r.category}: ${r.recommended}`).join(', ')}

请生成 3-5 个具体的后续步骤建议，返回 JSON 数组格式。
例如: ["步骤1", "步骤2"]
只返回 JSON 数组。`;

    try {
      const response = await this.llm.complete(prompt, '你是一个项目管理专家。生成后续步骤建议。只输出 JSON 数组。');
      const steps = this.parseJSON<string[]>(response.content);
      if (Array.isArray(steps)) {
        return steps;
      }
    } catch (error) {
      this.logger.warn('生成后续步骤失败', { error });
    }

    return [
      '基于研究结果完善需求文档',
      '确认隐含需求的优先级',
      '确定技术选型方案',
      '开始架构设计',
    ];
  }

  // ─── MessageBus Publishing ─────────────────────────────────────────────

  /**
   * 发布研究结果到 MessageBus
   */
  private publishResearchResult(report: ResearchReport, correlationId?: string): void {
    const payload: ResearchResultPayload = {
      projectId: report.projectId,
      projectName: report.projectName,
      report,
      correlationId,
    };

    // 发送给 orchestrator
    this.publish('task_completed', 'orchestrator', {
      ...payload,
      taskType: 'research',
    } as unknown as Record<string, unknown>, correlationId);

    // 发送给 architect
    this.publish('task_completed', 'architect', {
      ...payload,
      taskType: 'research',
    } as unknown as Record<string, unknown>, correlationId);

    this.logger.info('研究结果已发布', {
      reportId: report.id,
      rounds: report.rounds,
      findings: report.derivedRequirements.length,
    });
  }

  // ─── Utility Methods ───────────────────────────────────────────────────

  /**
   * 安全解析 JSON，支持 markdown 代码块包裹
   */
  private parseJSON<T>(text: string): T {
    // 尝试直接解析
    try {
      return JSON.parse(text) as T;
    } catch {
      // 尝试提取 markdown 代码块中的 JSON
      const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1].trim()) as T;
      }

      // 尝试提取第一个 [ 或 { 到最后一个 ] 或 }
      const startBracket = text.indexOf('[') !== -1 ? text.indexOf('[') : text.indexOf('{');
      const endBracket = text.lastIndexOf(']') !== -1 ? text.lastIndexOf(']') : text.lastIndexOf('}');

      if (startBracket !== -1 && endBracket > startBracket) {
        return JSON.parse(text.substring(startBracket, endBracket + 1)) as T;
      }

      throw new Error('无法从文本中提取有效 JSON');
    }
  }

  /**
   * 去重隐含需求（按标题）
   */
  private deduplicateDerivedRequirements(requirements: DerivedRequirement[]): DerivedRequirement[] {
    const seen = new Map<string, DerivedRequirement>();
    for (const req of requirements) {
      const key = req.title.toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, req);
      }
    }
    return Array.from(seen.values());
  }

  /**
   * 去重最佳实践（按标题）
   */
  private deduplicateBestPractices(practices: BestPractice[]): BestPractice[] {
    const seen = new Map<string, BestPractice>();
    for (const p of practices) {
      const key = p.title.toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, p);
      }
    }
    return Array.from(seen.values());
  }

  /**
   * 去重已知陷阱（按标题）
   */
  private deduplicatePitfalls(pitfalls: KnownPitfall[]): KnownPitfall[] {
    const seen = new Map<string, KnownPitfall>();
    for (const p of pitfalls) {
      const key = p.title.toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, p);
      }
    }
    return Array.from(seen.values());
  }

  /**
   * 获取当前研究报告（只读副本）
   */
  getCurrentReport(): ResearchReport | null {
    return this.currentReport ? { ...this.currentReport } : null;
  }
}
