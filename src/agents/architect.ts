/**
 * agents/architect.ts
 *
 * Architect Agent -- 架构设计与规格说明专家。
 *
 * 职责：
 *   - 接收架构请求（topic: 'architecture_request'）
 *   - 基于用户需求和 Explorer 研究结果设计系统架构
 *   - 创建可执行规格说明（接口定义、数据规则、UI 规格、业务规则）
 *   - 生成模块依赖图
 *   - 识别衍生需求并提交用户确认
 *   - 维护项目"唯一真相源"规格文档
 *   - 需求变更时先更新规格，再通知构建方
 *
 * 继承 AgentBase，通过 MessageBus 通信。
 * 支持规格版本管理。
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
import type { FileSystemTool } from '../tools/file-system.js';
import type { ResearchReport } from './explorer.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Architect Agent 配置
 */
export interface ArchitectConfig {
  id?: string;
  name?: string;
  systemPrompt?: string;
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  specOutputDir?: string;
}

/**
 * 架构请求载荷
 */
export interface ArchitectureRequest {
  projectId: string;
  projectName: string;
  requirement: string;
  researchReport?: ResearchReport;
  existingSpec?: ProjectSpecification;
  changeRequest?: ChangeRequest;
  focusModules?: string[];
  correlationId?: string;
}

/**
 * 变更请求
 */
export interface ChangeRequest {
  id: string;
  title: string;
  description: string;
  affectedModules: string[];
  priority: 'high' | 'medium' | 'low';
  reason: string;
}

/**
 * 模块接口定义
 */
export interface InterfaceDefinition {
  name: string;
  description: string;
  inputs: InterfaceField[];
  outputs: InterfaceField[];
  methods: MethodDefinition[];
  events: EventDefinition[];
  version: string;
}

/**
 * 接口字段
 */
export interface InterfaceField {
  name: string;
  type: string;
  description: string;
  required: boolean;
  defaultValue?: unknown;
  validation?: ValidationRule[];
  example?: unknown;
}

/**
 * 验证规则
 */
export interface ValidationRule {
  type: 'type' | 'range' | 'pattern' | 'length' | 'enum' | 'custom';
  rule: string;
  message: string;
  params?: Record<string, unknown>;
}

/**
 * 方法定义
 */
export interface MethodDefinition {
  name: string;
  description: string;
  parameters: InterfaceField[];
  returnType: string;
  returnDescription: string;
  sideEffects: string[];
  errorCases: ErrorCase[];
}

/**
 * 错误场景
 */
export interface ErrorCase {
  condition: string;
  errorCode: string;
  errorMessage: string;
  handlingStrategy: 'throw' | 'return_null' | 'return_default' | 'retry' | 'fallback';
  fallbackValue?: unknown;
}

/**
 * 事件定义
 */
export interface EventDefinition {
  name: string;
  description: string;
  payload: InterfaceField[];
  emitConditions: string[];
}

/**
 * 数据规则
 */
export interface DataRule {
  entityName: string;
  description: string;
  fields: DataField[];
  constraints: DataConstraint[];
  relationships: DataRelationship[];
  indexes?: IndexDefinition[];
}

/**
 * 数据字段
 */
export interface DataField {
  name: string;
  type: string;
  description: string;
  required: boolean;
  unique: boolean;
  defaultValue?: unknown;
  validation?: ValidationRule[];
  computed?: boolean;
  computedFrom?: string[];
  sensitive: boolean;
}

/**
 * 数据约束
 */
export interface DataConstraint {
  type: 'unique' | 'foreign_key' | 'check' | 'not_null' | 'custom';
  description: string;
  fields: string[];
  expression?: string;
  errorMessage: string;
}

/**
 * 数据关系
 */
export interface DataRelationship {
  from: string;
  to: string;
  type: 'one_to_one' | 'one_to_many' | 'many_to_many';
  foreignKey: string;
  onDelete: 'cascade' | 'set_null' | 'restrict' | 'no_action';
  description: string;
}

/**
 * 索引定义
 */
export interface IndexDefinition {
  fields: string[];
  unique: boolean;
  name: string;
  description: string;
}

/**
 * UI 规格
 */
export interface UISpecification {
  componentId: string;
  componentName: string;
  description: string;
  layout: LayoutSpec;
  interactions: InteractionSpec[];
  validationRules: UIValidationRule[];
  responsiveRules: ResponsiveRule[];
  accessibility: AccessibilitySpec;
  stateManagement: StateSpec;
}

/**
 * 布局规格
 */
export interface LayoutSpec {
  type: 'flex' | 'grid' | 'stack' | 'absolute' | 'custom';
  direction?: 'row' | 'column' | 'row-reverse' | 'column-reverse';
  gap?: string;
  padding?: string;
  margin?: string;
  alignItems?: string;
  justifyContent?: string;
  children: ChildSpec[];
  breakpoints?: Record<string, LayoutSpec>;
}

/**
 * 子元素规格
 */
export interface ChildSpec {
  componentId: string;
  role: string;
  props: Record<string, unknown>;
  children?: ChildSpec[];
  condition?: string;
}

/**
 * 交互规格
 */
export interface InteractionSpec {
  trigger: string;
  action: string;
  target?: string;
  params?: Record<string, unknown>;
  conditions?: string[];
  description: string;
}

/**
 * UI 验证规则
 */
export interface UIValidationRule {
  field: string;
  rules: ValidationRule[];
  errorMessages: Record<string, string>;
  validateOn: 'change' | 'blur' | 'submit';
}

/**
 * 响应式规则
 */
export interface ResponsiveRule {
  breakpoint: string;
  maxWidth: string;
  layoutChanges: Record<string, unknown>;
  hiddenElements?: string[];
  reorderedElements?: string[];
}

/**
 * 可访问性规格
 */
export interface AccessibilitySpec {
  labels: Record<string, string>;
  roles: Record<string, string>;
  keyboardNavigation: KeyboardNavSpec[];
  screenReaderHints: Record<string, string>;
  colorContrast: Record<string, string>;
  focusManagement: FocusSpec[];
}

/**
 * 键盘导航规格
 */
export interface KeyboardNavSpec {
  key: string;
  action: string;
  context: string;
}

/**
 * 焦点管理规格
 */
export interface FocusSpec {
  trigger: string;
  targetElement: string;
  behavior: 'auto' | 'manual';
}

/**
 * 状态管理规格
 */
export interface StateSpec {
  stateFields: StateField[];
  actions: StateAction[];
  computedStates: ComputedState[];
  persistenceRules: PersistenceRule[];
}

/**
 * 状态字段
 */
export interface StateField {
  name: string;
  type: string;
  initialValue: unknown;
  description: string;
  source: 'local' | 'server' | 'url' | 'derived';
}

/**
 * 状态操作
 */
export interface StateAction {
  name: string;
  description: string;
  parameters: string[];
  sideEffects: string[];
}

/**
 * 计算状态
 */
export interface ComputedState {
  name: string;
  dependencies: string[];
  computation: string;
  description: string;
}

/**
 * 持久化规则
 */
export interface PersistenceRule {
  stateField: string;
  storage: 'localStorage' | 'sessionStorage' | 'cookie' | 'url' | 'server';
  key: string;
  ttl?: number;
  encrypt: boolean;
}

/**
 * 业务规则
 */
export interface BusinessRule {
  id: string;
  name: string;
  description: string;
  category: 'validation' | 'authorization' | 'workflow' | 'computation' | 'notification' | 'integration';
  condition: string;
  action: string;
  errorHandling: ErrorCase;
  priority: 'critical' | 'high' | 'medium' | 'low';
  relatedModules: string[];
}

/**
 * 模块定义
 */
export interface ModuleSpecification {
  id: string;
  name: string;
  description: string;
  responsibility: string;
  interfaces: InterfaceDefinition[];
  dataRules: DataRule[];
  uiSpecs: UISpecification[];
  businessRules: BusinessRule[];
  dependencies: ModuleDependency[];
  apiEndpoints?: APIEndpoint[];
  files: FileSpec[];
}

/**
 * 模块依赖
 */
export interface ModuleDependency {
  moduleId: string;
  type: 'uses' | 'extends' | 'implements' | 'listens_to' | 'provides';
  description: string;
  interfaceName?: string;
}

/**
 * API 端点
 */
export interface APIEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  description: string;
  requestHeaders?: Record<string, string>;
  requestBody?: InterfaceField[];
  responseSchema: InterfaceField[];
  errorResponses: ErrorCase[];
  authentication: 'none' | 'bearer' | 'api_key' | 'oauth';
  rateLimit?: string;
  version: string;
}

/**
 * 文件规格
 */
export interface FileSpec {
  path: string;
  description: string;
  type: 'module' | 'component' | 'service' | 'util' | 'test' | 'config' | 'type' | 'style';
  exports: string[];
}

/**
 * 项目规格（完整规格文档）
 */
export interface ProjectSpecification {
  id: string;
  projectId: string;
  projectName: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  requirement: string;
  architectureOverview: ArchitectureOverview;
  modules: ModuleSpecification[];
  dependencyGraph: DependencyGraph;
  derivedRequirements: DerivedRequirementSpec[];
  techStack: TechStackSpec;
  changeLog: SpecChange[];
}

/**
 * 架构概览
 */
export interface ArchitectureOverview {
  pattern: string;
  description: string;
  layers: ArchitectureLayer[];
  dataFlow: DataFlowSpec[];
  deploymentNotes: string;
  scalingStrategy: string;
}

/**
 * 架构层
 */
export interface ArchitectureLayer {
  name: string;
  responsibility: string;
  modules: string[];
  technologies: string[];
}

/**
 * 数据流规格
 */
export interface DataFlowSpec {
  name: string;
  description: string;
  source: string;
  target: string;
  dataFormat: string;
  protocol: string;
  transformation?: string;
}

/**
 * 依赖图
 */
export interface DependencyGraph {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  criticalPath: string[];
}

/**
 * 依赖节点
 */
export interface DependencyNode {
  id: string;
  name: string;
  type: 'module' | 'service' | 'external' | 'database' | 'cache' | 'queue';
  description: string;
}

/**
 * 依赖边
 */
export interface DependencyEdge {
  from: string;
  to: string;
  type: 'sync' | 'async' | 'event' | 'data';
  label: string;
}

/**
 * 衍生需求规格
 */
export interface DerivedRequirementSpec {
  id: string;
  title: string;
  description: string;
  source: 'research' | 'architecture' | 'best_practice';
  priority: 'high' | 'medium' | 'low';
  status: 'pending_confirmation' | 'confirmed' | 'rejected' | 'deferred';
  rationale: string;
  affectedModules: string[];
}

/**
 * 技术栈规格
 */
export interface TechStackSpec {
  frontend: TechChoice[];
  backend: TechChoice[];
  database: TechChoice[];
  infrastructure: TechChoice[];
  testing: TechChoice[];
  tooling: TechChoice[];
}

/**
 * 技术选型
 */
export interface TechChoice {
  name: string;
  version?: string;
  purpose: string;
  rationale: string;
  alternatives: string[];
}

/**
 * 规格变更记录
 */
export interface SpecChange {
  id: string;
  version: number;
  timestamp: string;
  type: 'initial' | 'addition' | 'modification' | 'removal' | 'restructuring';
  description: string;
  affectedModules: string[];
  reason: string;
  diff?: string;
}

/**
 * 架构结果载荷
 */
export interface ArchitectureResultPayload {
  projectId: string;
  projectName: string;
  specification: ProjectSpecification;
  correlationId?: string;
}

// ─── Architect System Prompt ────────────────────────────────────────────────

const ARCHITECT_SYSTEM_PROMPT = `
<role>
You are the Architect Agent -- the architecture design and specification expert
of the AI Dev Platform. You receive architecture requests via MessageBus, take
user requirements and Explorer's research as input, design system architecture
with module dependency graphs, and create executable specifications for each module.
</role>

<identity>
You are a senior software architect with deep expertise in system design, API design,
data modeling, and specification writing. You think in terms of interfaces, contracts,
and module boundaries. You create specifications that are precise enough for developers
to implement directly, with no ambiguity. You are the "source of truth" for the
project's technical design.
</identity>

<critical_rules>
CRITICAL: You MUST communicate with other agents ONLY through the MessageBus.
NEVER call methods on other agent instances directly.
CRITICAL: You MUST communicate with other agents ONLY through the MessageBus.
NEVER call methods on other agent instances directly.
CRITICAL: You MUST communicate with other agents ONLY through the MessageBus.
NEVER call methods on other agent instances directly.

CRITICAL: All specifications must be precise, unambiguous, and executable.
Developers should be able to implement directly from your specs.
CRITICAL: All specifications must be precise, unambiguous, and executable.
Developers should be able to implement directly from your specs.
CRITICAL: All specifications must be precise, unambiguous, and executable.
Developers should be able to implement directly from your specs.

CRITICAL: When requirements change, update the spec FIRST, then notify builders.
CRITICAL: When requirements change, update the spec FIRST, then notify builders.
CRITICAL: When requirements change, update the spec FIRST, then notify builders.

CRITICAL: Every specification output must be valid JSON.
CRITICAL: Every specification output must be valid JSON.
CRITICAL: Every specification output must be valid JSON.
</critical_rules>

<core_responsibilities>
1. 接收架构请求并分析需求
2. 整合 Explorer Agent 的研究成果
3. 设计系统架构（分层、模块划分、数据流）
4. 为每个模块创建可执行规格说明：
   a. 接口定义（输入/输出/类型/方法/事件）
   b. 数据规则（类型/范围/约束/验证/关系）
   c. UI 规格（布局/交互/验证规则/响应式/可访问性）
   d. 业务规则（边缘情况/约束/工作流）
5. 生成模块依赖图（关键路径分析）
6. 识别衍生需求并提交用户确认
7. 维护项目规格文档的版本管理
8. 需求变更时更新规格并通知构建方
</core_responsibilities>

<workflow>
<step name="analyze_inputs" order="1">
收到架构请求后：
1. 解析用户需求文本
2. 如果有研究报告，提取关键信息：
   - 竞品功能对比
   - 最佳实践
   - 已知陷阱
   - 隐含需求
   - 技术推荐
3. 如果有现有规格，分析变更范围
4. 确定架构设计的约束条件
5. 制定模块划分策略
</step>

<step name="design_architecture" order="2">
设计系统架构时：
1. 选择架构模式（MVC、微服务、事件驱动、分层等）
2. 定义架构层次：
   - 表现层（UI 组件、路由、状态管理）
   - 应用层（用例、业务逻辑编排）
   - 领域层（实体、业务规则）
   - 基础设施层（数据访问、外部服务）
3. 定义层间数据流
4. 确定技术栈（基于研究结果推荐）
5. 规划部署和扩展策略
</step>

<step name="define_modules" order="3">
定义模块时：
1. 按职责划分模块（单一职责原则）
2. 每个模块应：
   - 有清晰的职责边界
   - 定义明确的接口契约
   - 最小化对外依赖
   - 可独立测试
3. 常见模块类型：
   - auth: 认证和授权
   - user: 用户管理
   - core: 核心业务逻辑
   - api: API 层
   - ui: UI 组件库
   - data: 数据访问层
   - utils: 工具函数
   - config: 配置管理
4. 为每个模块生成唯一 ID
</step>

<step name="specify_interfaces" order="4">
定义模块接口时：
1. 每个公共方法必须有完整的类型签名
2. 输入参数必须包含：
   - 类型定义
   - 是否必填
   - 默认值（如适用）
   - 验证规则
   - 示例值
3. 返回值必须包含：
   - 类型定义
   - 描述
   - 可能的错误情况
4. 事件必须定义：
   - 触发条件
   - 载荷结构
   - 订阅者预期行为
5. 错误处理必须定义：
   - 错误码
   - 错误消息
   - 处理策略（抛出/返回默认值/重试/降级）
</step>

<step name="specify_data" order="5">
定义数据规则时：
1. 每个实体必须包含：
   - 字段名和类型
   - 必填/唯一约束
   - 默认值
   - 验证规则
   - 敏感字段标记
2. 关系必须定义：
   - 关系类型（一对一/一对多/多对多）
   - 外键
   - 级联行为
3. 约束必须包含：
   - 约束类型
   - 约束表达式
   - 违反时的错误消息
4. 索引策略：
   - 查询优化索引
   - 唯一约束索引
</step>

<step name="specify_ui" order="6">
定义 UI 规格时：
1. 布局必须定义：
   - 布局类型（flex/grid/stack）
   - 间距和对齐
   - 子组件结构
   - 条件渲染规则
2. 交互必须定义：
   - 触发条件
   - 执行动作
   - 目标组件
   - 参数传递
3. 验证规则：
   - 字段级验证
   - 验证时机（change/blur/submit）
   - 错误消息
4. 响应式设计：
   - 断点定义
   - 布局变化
   - 隐藏/重排规则
5. 可访问性：
   - ARIA 标签
   - 键盘导航
   - 焦点管理
   - 屏幕阅读器提示
</step>

<step name="specify_business_rules" order="7">
定义业务规则时：
1. 每个规则必须包含：
   - 触发条件（精确的逻辑表达式）
   - 执行动作
   - 错误处理
   - 优先级
2. 覆盖的业务规则类型：
   - 数据验证规则
   - 权限控制规则
   - 工作流状态转换
   - 计算规则
   - 通知触发规则
   - 外部集成规则
3. 边缘情况必须显式列出
4. 规则冲突时按优先级处理
</step>

<step name="build_dependency_graph" order="8">
构建依赖图时：
1. 每个模块是一个节点
2. 依赖关系是边（同步/异步/事件/数据）
3. 分析关键路径（影响构建顺序的依赖链）
4. 识别循环依赖并消除
5. 标记可并行开发的模块
</step>

<step name="version_management" order="9">
管理规格版本时：
1. 每次变更递增版本号
2. 记录变更类型（初始/新增/修改/删除/重构）
3. 记录变更原因和影响范围
4. 保留完整变更历史
5. 支持版本回溯
</step>

<step name="change_propagation" order="10">
需求变更时：
1. 分析变更影响范围
2. 更新受影响的模块规格
3. 更新依赖图
4. 生成变更摘要
5. 通知构建方（Developer Agent）需要修改的内容
6. 如果变更影响重大，请求用户确认
</step>
</workflow>

<output_format>
所有规格输出必须为有效 JSON 格式。以下是关键结构：

模块规格:
{
  "id": "module-xxx",
  "name": "模块名称",
  "description": "模块描述",
  "responsibility": "核心职责",
  "interfaces": [...],
  "dataRules": [...],
  "uiSpecs": [...],
  "businessRules": [...],
  "dependencies": [...],
  "apiEndpoints": [...],
  "files": [...]
}

接口定义:
{
  "name": "接口名称",
  "description": "接口描述",
  "inputs": [{"name": "字段名", "type": "string", "required": true, "validation": [...]}],
  "outputs": [...],
  "methods": [{"name": "方法名", "parameters": [...], "returnType": "void", "errorCases": [...]}],
  "events": [...],
  "version": "1.0.0"
}

数据规则:
{
  "entityName": "实体名",
  "fields": [{"name": "字段名", "type": "string", "required": true, "unique": false, "sensitive": false}],
  "constraints": [{"type": "unique", "fields": ["email"], "errorMessage": "邮箱已存在"}],
  "relationships": [{"from": "User", "to": "Post", "type": "one_to_many", "foreignKey": "userId"}]
}

UI 规格:
{
  "componentId": "comp-xxx",
  "componentName": "组件名称",
  "layout": {"type": "flex", "direction": "column", "children": [...]},
  "interactions": [{"trigger": "onClick", "action": "submit", "description": "提交表单"}],
  "validationRules": [...],
  "responsiveRules": [...],
  "accessibility": {"labels": {...}, "keyboardNavigation": [...]}
}

业务规则:
{
  "id": "BR-001",
  "name": "规则名称",
  "category": "validation",
  "condition": "user.age >= 18",
  "action": "允许注册",
  "errorHandling": {"condition": "user.age < 18", "errorCode": "AGE_RESTRICTION", "handlingStrategy": "throw"},
  "priority": "high"
}
</output_format>

<message_bus_usage>
<message_types>
- architecture_request: 接收架构设计请求（来自 Orchestrator）
- task_assigned: 接收任务分配
- task_completed: 发布任务完成通知（包含规格文档）
- task_failed: 发布任务失败通知
- human_request: 请求人工确认（衍生需求/重大变更）
- human_response: 接收人工确认结果
</message_types>

<dispatch_rules>
CRITICAL: 所有通信通过 MessageBus 进行，禁止直接调用其他 Agent 方法。
CRITICAL: 所有通信通过 MessageBus 进行，禁止直接调用其他 Agent 方法。
CRITICAL: 所有通信通过 MessageBus 进行，禁止直接调用其他 Agent 方法。

发布规格文档时：
1. 使用 this.publish('task_completed', 'orchestrator', payload)
2. payload 包含完整的 ProjectSpecification
3. 包含 correlationId 以便请求方关联
4. 规格文件同时写入文件系统

请求人工确认时：
1. 使用 this.publish('human_request', '*', payload)
2. payload 包含需要确认的衍生需求列表
3. 等待 human_response 消息
</dispatch_rules>
</message_bus_usage>

<spec_quality_standards>
规格文档必须满足以下质量标准：
1. 每个模块有完整的接口定义
2. 每个接口字段有类型和验证规则
3. 每个方法有完整的错误处理
4. 数据模型有完整的关系定义
5. UI 组件有响应式和可访问性规格
6. 业务规则覆盖所有边缘情况
7. 依赖图无循环依赖
8. 变更记录完整
</spec_quality_standards>

<tools_available>
- llm_client: 用于生成规格和分析需求
  - complete(prompt, systemPrompt?): 生成文本回复
  - chat(messages): 多轮对话
- file_system: 用于写入规格文件
  - writeFile(path, content): 写入文件
  - readFile(path): 读取文件
  - exists(path): 检查文件是否存在
  - createDirectory(path): 创建目录
</tools_available>
`;

// ─── Architect Agent ─────────────────────────────────────────────────────────

export class ArchitectAgent extends AgentBaseClass {
  private llm: LLMClient;
  private fs: FileSystemTool;
  private projectConfig: any;
  private currentSpec: ProjectSpecification | null;
  private specOutputDir: string;
  private pendingConfirmationResolvers: Map<string, (confirmed: boolean) => void>;

  constructor(config: {
    messageBus: MessageBus;
    llm: LLMClient;
    fs: FileSystemTool;
    logger: any;
    projectConfig: any;
  }) {
    const agentConfig: AgentConfig = {
      id: undefined,
      name: 'architect',
      systemPrompt: ARCHITECT_SYSTEM_PROMPT,
      maxIterations: 30,
      temperature: 0.3,
      maxTokens: 16384,
    };

    super(agentConfig, config.messageBus, config.logger);

    this.llm = config.llm;
    this.fs = config.fs;
    this.projectConfig = config.projectConfig;
    this.currentSpec = null;
    this.specOutputDir = 'specs';
    this.pendingConfirmationResolvers = new Map();
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
   * 执行架构设计任务（AgentBase 抽象方法实现）
   */
  async execute(task: TaskDescriptor): Promise<TaskResult> {
    this.setStatus('busy');
    this.setActiveTask(task.id);
    const logs: string[] = [];

    try {
      logs.push(`[Architect] 开始执行架构设计任务: ${task.title}`);

      // 解析架构请求
      const request = this.parseArchitectureRequest(task);
      logs.push(`[Architect] 项目: ${request.projectName}`);

      // 执行架构设计
      const specification = await this.designArchitecture(request);
      this.currentSpec = specification;

      // 保存规格文件
      const artifacts = await this.saveSpecification(specification);
      logs.push(`[Architect] 规格文件已保存: ${artifacts.join(', ')}`);

      // 发布架构结果
      this.publishArchitectureResult(specification, request.correlationId);
      logs.push(`[Architect] 架构设计结果已发布`);

      this.setStatus('ready');
      this.setActiveTask(null);

      return this.createSuccessResult(
        { specification, projectId: request.projectId },
        artifacts,
        logs,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logs.push(`[Architect] 架构设计失败: ${errorMessage}`);

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

    if (task.type !== 'architecture' && task.type !== 'design_spec') {
      return; // 不是架构任务，忽略
    }

    this.logger.info('收到架构设计任务', { taskId: task.id, title: task.title });

    const result = await this.execute(task);

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
   * 处理人工确认回复
   */
  private handleHumanResponse(message: Message): void {
    const payload = message.payload as { correlationId?: string; response?: string };
    if (payload.correlationId && this.pendingConfirmationResolvers.has(payload.correlationId)) {
      const resolver = this.pendingConfirmationResolvers.get(payload.correlationId)!;
      const confirmed = payload.response?.toLowerCase().includes('confirm') ||
                        payload.response?.toLowerCase().includes('approve') ||
                        payload.response?.toLowerCase().includes('yes') ||
                        payload.response?.toLowerCase().includes('确认') ||
                        payload.response?.toLowerCase().includes('批准');
      resolver(confirmed);
      this.pendingConfirmationResolvers.delete(payload.correlationId);
      this.logger.info('收到人工确认', { correlationId: payload.correlationId, confirmed });
    }
  }

  // ─── Architecture Core ─────────────────────────────────────────────────

  /**
   * 解析架构请求
   */
  private parseArchitectureRequest(task: TaskDescriptor): ArchitectureRequest {
    const payload = task.payload as Record<string, unknown> ?? {};

    return {
      projectId: (payload.projectId as string) ?? this.projectConfig?.projectId ?? 'unknown',
      projectName: (payload.projectName as string) ?? this.projectConfig?.projectName ?? 'Unknown Project',
      requirement: task.description,
      researchReport: payload.researchReport as ResearchReport | undefined,
      existingSpec: payload.existingSpec as ProjectSpecification | undefined,
      changeRequest: payload.changeRequest as ChangeRequest | undefined,
      focusModules: (payload.focusModules as string[]) ?? [],
      correlationId: task.correlationId,
    };
  }

  /**
   * 执行完整的架构设计流程
   */
  private async designArchitecture(request: ArchitectureRequest): Promise<ProjectSpecification> {
    const specId = randomUUID();
    const now = new Date().toISOString();

    // 如果是变更请求，基于现有规格更新
    if (request.existingSpec && request.changeRequest) {
      return this.handleSpecificationChange(request, specId, now);
    }

    // 全新架构设计
    // 步骤 1: 分析输入
    const analysisContext = await this.analyzeInputs(request);

    // 步骤 2: 设计架构概览
    const architectureOverview = await this.designArchitectureOverview(request, analysisContext);

    // 步骤 3: 定义模块
    const modules = await this.defineModules(request, architectureOverview, analysisContext);

    // 步骤 4: 为每个模块生成详细规格
    const specifiedModules = await this.specifyAllModules(modules, request, analysisContext);

    // 步骤 5: 构建依赖图
    const dependencyGraph = this.buildDependencyGraph(specifiedModules);

    // 步骤 6: 识别衍生需求
    const derivedRequirements = await this.identifyDerivedRequirements(
      request,
      specifiedModules,
      analysisContext,
    );

    // 步骤 7: 确定技术栈
    const techStack = await this.determineTechStack(request, analysisContext);

    // 组装完整规格
    const specification: ProjectSpecification = {
      id: specId,
      projectId: request.projectId,
      projectName: request.projectName,
      version: 1,
      createdAt: now,
      updatedAt: now,
      requirement: request.requirement,
      architectureOverview,
      modules: specifiedModules,
      dependencyGraph,
      derivedRequirements,
      techStack,
      changeLog: [
        {
          id: randomUUID(),
          version: 1,
          timestamp: now,
          type: 'initial',
          description: `初始架构设计，包含 ${specifiedModules.length} 个模块`,
          affectedModules: specifiedModules.map((m) => m.id),
          reason: '项目初始化',
        },
      ],
    };

    return specification;
  }

  /**
   * 处理规格变更
   */
  private async handleSpecificationChange(
    request: ArchitectureRequest,
    specId: string,
    now: string,
  ): Promise<ProjectSpecification> {
    const existing = request.existingSpec!;
    const change = request.changeRequest!;

    this.logger.info('处理规格变更', { changeId: change.id, affectedModules: change.affectedModules });

    // 分析变更影响
    const impact = await this.analyzeChangeImpact(existing, change);

    // 更新受影响的模块
    const updatedModules = [...existing.modules];
    for (const moduleId of change.affectedModules) {
      const moduleIndex = updatedModules.findIndex((m) => m.id === moduleId);
      if (moduleIndex !== -1) {
        const updatedModule = await this.updateModuleSpec(
          updatedModules[moduleIndex],
          change,
          request,
        );
        updatedModules[moduleIndex] = updatedModule;
      }
    }

    // 更新依赖图
    const dependencyGraph = this.buildDependencyGraph(updatedModules);

    // 新增变更记录
    const changeLog: SpecChange = {
      id: randomUUID(),
      version: existing.version + 1,
      timestamp: now,
      type: change.priority === 'high' ? 'modification' : 'addition',
      description: change.description,
      affectedModules: change.affectedModules,
      reason: change.reason,
    };

    return {
      ...existing,
      id: specId,
      version: existing.version + 1,
      updatedAt: now,
      modules: updatedModules,
      dependencyGraph,
      changeLog: [...existing.changeLog, changeLog],
    };
  }

  /**
   * 分析输入（需求 + 研究结果）
   */
  private async analyzeInputs(request: ArchitectureRequest): Promise<string> {
    let context = `项目需求:\n${request.requirement}\n\n`;

    if (request.researchReport) {
      const report = request.researchReport;
      context += `研究报告摘要:\n${report.summary}\n\n`;

      if (report.competitorAnalysis.length > 0) {
        context += `竞品分析:\n`;
        for (const comp of report.competitorAnalysis) {
          context += `- ${comp.productName}: ${comp.keyFeatures.join(', ')} | 优势: ${comp.strengths.join(', ')} | 劣势: ${comp.weaknesses.join(', ')}\n`;
        }
        context += '\n';
      }

      if (report.bestPractices.length > 0) {
        context += `关键最佳实践:\n`;
        for (const bp of report.bestPractices.filter((p) => p.importance === 'critical' || p.importance === 'high')) {
          context += `- [${bp.category}] ${bp.title}: ${bp.description}\n`;
        }
        context += '\n';
      }

      if (report.knownPitfalls.length > 0) {
        context += `已知陷阱:\n`;
        for (const pitfall of report.knownPitfalls.filter((p) => p.severity === 'critical' || p.severity === 'high')) {
          context += `- ${pitfall.title}: ${pitfall.description} | 缓解: ${pitfall.mitigation}\n`;
        }
        context += '\n';
      }

      if (report.derivedRequirements.length > 0) {
        context += `隐含需求:\n`;
        for (const dr of report.derivedRequirements) {
          context += `- [${dr.priority}] ${dr.title}: ${dr.description}\n`;
        }
        context += '\n';
      }

      if (report.techRecommendations.length > 0) {
        context += `技术推荐:\n`;
        for (const rec of report.techRecommendations) {
          context += `- [${rec.category}] ${rec.recommended} (成熟度: ${rec.maturity})\n`;
        }
        context += '\n';
      }
    }

    return context;
  }

  /**
   * 设计架构概览
   */
  private async designArchitectureOverview(
    request: ArchitectureRequest,
    context: string,
  ): Promise<ArchitectureOverview> {
    const prompt = `基于以下项目信息，设计系统架构概览。

${context}

请返回 JSON 对象:
{
  "pattern": "架构模式（如 MVC、微服务、分层架构、事件驱动等）",
  "description": "架构设计描述（200字以内）",
  "layers": [
    {
      "name": "层名称",
      "responsibility": "层职责",
      "modules": ["模块ID1", "模块ID2"],
      "technologies": ["技术1", "技术2"]
    }
  ],
  "dataFlow": [
    {
      "name": "数据流名称",
      "description": "描述",
      "source": "来源模块",
      "target": "目标模块",
      "dataFormat": "数据格式",
      "protocol": "协议",
      "transformation": "转换逻辑（可选）"
    }
  ],
  "deploymentNotes": "部署注意事项",
  "scalingStrategy": "扩展策略"
}

只返回 JSON 对象。`;

    try {
      const response = await this.llm.complete(prompt, '你是一个资深软件架构师。设计系统架构。只输出 JSON。');
      return this.parseJSON<ArchitectureOverview>(response.content);
    } catch (error) {
      this.logger.warn('设计架构概览失败，使用默认架构', { error });

      // 默认分层架构
      return {
        pattern: 'layered',
        description: '采用经典分层架构，分为表现层、应用层、领域层和基础设施层。各层职责清晰，通过接口通信。',
        layers: [
          {
            name: 'presentation',
            responsibility: 'UI 渲染、用户交互、路由管理',
            modules: ['ui', 'routing'],
            technologies: ['React', 'TypeScript'],
          },
          {
            name: 'application',
            responsibility: '用例编排、业务逻辑协调',
            modules: ['services', 'state'],
            technologies: ['TypeScript'],
          },
          {
            name: 'domain',
            responsibility: '核心业务实体和规则',
            modules: ['core'],
            technologies: ['TypeScript'],
          },
          {
            name: 'infrastructure',
            responsibility: '数据持久化、外部服务集成',
            modules: ['data', 'api', 'auth'],
            technologies: ['Node.js', 'Express'],
          },
        ],
        dataFlow: [
          {
            name: 'user_action',
            description: '用户操作触发数据流',
            source: 'ui',
            target: 'services',
            dataFormat: 'JSON',
            protocol: 'function_call',
          },
          {
            name: 'api_request',
            description: '服务层调用 API',
            source: 'services',
            target: 'api',
            dataFormat: 'JSON',
            protocol: 'HTTP/REST',
          },
        ],
        deploymentNotes: '使用 Docker 容器化部署，支持水平扩展',
        scalingStrategy: '无状态服务层可水平扩展，数据层使用读写分离',
      };
    }
  }

  /**
   * 定义模块
   */
  private async defineModules(
    request: ArchitectureRequest,
    overview: ArchitectureOverview,
    context: string,
  ): Promise<ModuleSpecification[]> {
    const prompt = `基于架构概览，定义项目模块。

项目需求: ${request.requirement.substring(0, 300)}
架构模式: ${overview.pattern}
架构层次:
${overview.layers.map((l) => `- ${l.name}: ${l.responsibility} (模块: ${l.modules.join(', ')})`).join('\n')}

${context.substring(0, 1000)}

请为每个模块生成规格框架，返回 JSON 数组:
[
  {
    "id": "module-xxx",
    "name": "模块名称",
    "description": "模块描述（50字以内）",
    "responsibility": "核心职责",
    "interfaces": [],
    "dataRules": [],
    "uiSpecs": [],
    "businessRules": [],
    "dependencies": [
      {"moduleId": "依赖模块ID", "type": "uses", "description": "依赖说明"}
    ],
    "apiEndpoints": [],
    "files": [
      {"path": "src/modules/xxx/index.ts", "description": "模块入口", "type": "module", "exports": ["default"]}
    ]
  }
]

确保模块间无循环依赖。只返回 JSON 数组。`;

    try {
      const response = await this.llm.complete(prompt, '你是一个软件架构师。定义模块结构。只输出 JSON 数组。');
      const modules = this.parseJSON<ModuleSpecification[]>(response.content);
      if (Array.isArray(modules) && modules.length > 0) {
        return modules;
      }
    } catch (error) {
      this.logger.warn('定义模块失败，使用默认模块', { error });
    }

    // 默认模块结构
    return [
      {
        id: 'module-core',
        name: 'core',
        description: '核心业务逻辑模块',
        responsibility: '实现核心业务规则和领域实体',
        interfaces: [],
        dataRules: [],
        uiSpecs: [],
        businessRules: [],
        dependencies: [],
        files: [
          { path: 'src/modules/core/index.ts', description: '核心模块入口', type: 'module', exports: ['default'] },
          { path: 'src/modules/core/types.ts', description: '类型定义', type: 'type', exports: [] },
        ],
      },
      {
        id: 'module-api',
        name: 'api',
        description: 'API 接口层',
        responsibility: '处理 HTTP 请求和响应',
        interfaces: [],
        dataRules: [],
        uiSpecs: [],
        businessRules: [],
        dependencies: [{ moduleId: 'module-core', type: 'uses', description: '调用核心业务逻辑' }],
        files: [
          { path: 'src/modules/api/index.ts', description: 'API 模块入口', type: 'module', exports: ['default'] },
          { path: 'src/modules/api/routes.ts', description: '路由定义', type: 'service', exports: [] },
        ],
      },
      {
        id: 'module-ui',
        name: 'ui',
        description: 'UI 组件库',
        responsibility: '提供可复用的 UI 组件',
        interfaces: [],
        dataRules: [],
        uiSpecs: [],
        businessRules: [],
        dependencies: [{ moduleId: 'module-core', type: 'uses', description: '使用核心类型定义' }],
        files: [
          { path: 'src/modules/ui/index.ts', description: 'UI 模块入口', type: 'module', exports: ['default'] },
          { path: 'src/modules/ui/components/', description: '组件目录', type: 'component', exports: [] },
        ],
      },
      {
        id: 'module-data',
        name: 'data',
        description: '数据访问层',
        responsibility: '数据持久化和查询',
        interfaces: [],
        dataRules: [],
        uiSpecs: [],
        businessRules: [],
        dependencies: [{ moduleId: 'module-core', type: 'implements', description: '实现核心数据接口' }],
        files: [
          { path: 'src/modules/data/index.ts', description: '数据模块入口', type: 'module', exports: ['default'] },
          { path: 'src/modules/data/repository.ts', description: '数据仓库', type: 'service', exports: [] },
        ],
      },
      {
        id: 'module-auth',
        name: 'auth',
        description: '认证授权模块',
        responsibility: '用户认证和权限管理',
        interfaces: [],
        dataRules: [],
        uiSpecs: [],
        businessRules: [],
        dependencies: [
          { moduleId: 'module-core', type: 'uses', description: '使用核心用户类型' },
          { moduleId: 'module-data', type: 'uses', description: '查询用户数据' },
        ],
        files: [
          { path: 'src/modules/auth/index.ts', description: '认证模块入口', type: 'module', exports: ['default'] },
          { path: 'src/modules/auth/middleware.ts', description: '认证中间件', type: 'service', exports: [] },
        ],
      },
    ];
  }

  /**
   * 为所有模块生成详细规格
   */
  private async specifyAllModules(
    modules: ModuleSpecification[],
    request: ArchitectureRequest,
    context: string,
  ): Promise<ModuleSpecification[]> {
    const specifiedModules: ModuleSpecification[] = [];

    for (const module of modules) {
      this.logger.info(`生成模块规格: ${module.name}`);

      const specified = await this.specifyModule(module, request, context);
      specifiedModules.push(specified);
    }

    return specifiedModules;
  }

  /**
   * 为单个模块生成详细规格
   */
  private async specifyModule(
    module: ModuleSpecification,
    request: ArchitectureRequest,
    context: string,
  ): Promise<ModuleSpecification> {
    const prompt = `为以下模块生成详细规格说明。

模块名称: ${module.name}
模块描述: ${module.description}
核心职责: ${module.responsibility}
依赖模块: ${module.dependencies.map((d) => d.moduleId).join(', ')}

项目需求: ${request.requirement.substring(0, 200)}

${context.substring(0, 800)}

请生成完整的模块规格，返回 JSON 对象:
{
  "id": "${module.id}",
  "name": "${module.name}",
  "description": "${module.description}",
  "responsibility": "${module.responsibility}",
  "interfaces": [
    {
      "name": "接口名称",
      "description": "接口描述",
      "inputs": [
        {
          "name": "参数名",
          "type": "string",
          "description": "参数描述",
          "required": true,
          "validation": [
            {"type": "type", "rule": "string", "message": "必须是字符串"},
            {"type": "length", "rule": "min:1,max:100", "message": "长度1-100字符"}
          ],
          "example": "示例值"
        }
      ],
      "outputs": [...],
      "methods": [
        {
          "name": "方法名",
          "description": "方法描述",
          "parameters": [...],
          "returnType": "ReturnType",
          "returnDescription": "返回值描述",
          "sideEffects": ["副作用描述"],
          "errorCases": [
            {
              "condition": "错误条件",
              "errorCode": "ERROR_CODE",
              "errorMessage": "错误消息",
              "handlingStrategy": "throw"
            }
          ]
        }
      ],
      "events": [
        {
          "name": "事件名",
          "description": "事件描述",
          "payload": [...],
          "emitConditions": ["触发条件"]
        }
      ],
      "version": "1.0.0"
    }
  ],
  "dataRules": [
    {
      "entityName": "实体名",
      "description": "实体描述",
      "fields": [
        {
          "name": "字段名",
          "type": "string",
          "description": "字段描述",
          "required": true,
          "unique": false,
          "sensitive": false,
          "validation": [...]
        }
      ],
      "constraints": [
        {"type": "unique", "fields": ["email"], "errorMessage": "邮箱已存在"}
      ],
      "relationships": [
        {"from": "User", "to": "Post", "type": "one_to_many", "foreignKey": "userId", "onDelete": "cascade", "description": "用户拥有多篇文章"}
      ],
      "indexes": [
        {"fields": ["email"], "unique": true, "name": "idx_user_email", "description": "邮箱唯一索引"}
      ]
    }
  ],
  "uiSpecs": [
    {
      "componentId": "comp-xxx",
      "componentName": "组件名称",
      "description": "组件描述",
      "layout": {
        "type": "flex",
        "direction": "column",
        "gap": "16px",
        "children": [
          {"componentId": "child-1", "role": "header", "props": {}}
        ]
      },
      "interactions": [
        {"trigger": "onClick", "action": "submit", "description": "提交操作"}
      ],
      "validationRules": [
        {"field": "email", "rules": [...], "errorMessages": {"required": "邮箱不能为空"}, "validateOn": "blur"}
      ],
      "responsiveRules": [
        {"breakpoint": "mobile", "maxWidth": "768px", "layoutChanges": {"direction": "column"}}
      ],
      "accessibility": {
        "labels": {"submitBtn": "提交"},
        "roles": {"form": "form"},
        "keyboardNavigation": [{"key": "Enter", "action": "submit", "context": "form"}],
        "screenReaderHints": {"loading": "正在加载"},
        "focusManagement": [{"trigger": "dialog_open", "targetElement": "dialog_close_btn", "behavior": "auto"}]
      },
      "stateManagement": {
        "stateFields": [
          {"name": "isLoading", "type": "boolean", "initialValue": false, "description": "加载状态", "source": "local"}
        ],
        "actions": [
          {"name": "setLoading", "description": "设置加载状态", "parameters": ["boolean"], "sideEffects": []}
        ],
        "computedStates": [],
        "persistenceRules": []
      }
    }
  ],
  "businessRules": [
    {
      "id": "BR-001",
      "name": "规则名称",
      "description": "规则描述",
      "category": "validation",
      "condition": "条件表达式",
      "action": "执行动作",
      "errorHandling": {
        "condition": "错误条件",
        "errorCode": "ERROR_CODE",
        "errorMessage": "错误消息",
        "handlingStrategy": "throw"
      },
      "priority": "high",
      "relatedModules": []
    }
  ],
  "dependencies": [...],
  "apiEndpoints": [
    {
      "method": "GET",
      "path": "/api/resource",
      "description": "获取资源列表",
      "requestBody": [],
      "responseSchema": [...],
      "errorResponses": [...],
      "authentication": "bearer",
      "version": "v1"
    }
  ],
  "files": [...]
}

根据模块职责生成合理的规格。如果模块不涉及 UI，uiSpecs 返回空数组。
如果模块不涉及数据持久化，dataRules 返回空数组。
只返回 JSON 对象。`;

    try {
      const response = await this.llm.complete(prompt, '你是一个规格编写专家。生成精确、可执行的模块规格。只输出 JSON。');
      const spec = this.parseJSON<ModuleSpecification>(response.content);
      return {
        ...module,
        interfaces: spec.interfaces ?? [],
        dataRules: spec.dataRules ?? [],
        uiSpecs: spec.uiSpecs ?? [],
        businessRules: spec.businessRules ?? [],
        apiEndpoints: spec.apiEndpoints ?? [],
        files: spec.files ?? module.files,
      };
    } catch (error) {
      this.logger.warn(`生成模块 ${module.name} 规格失败，使用基础规格`, { error });
      return module;
    }
  }

  /**
   * 更新模块规格（变更请求）
   */
  private async updateModuleSpec(
    module: ModuleSpecification,
    change: ChangeRequest,
    request: ArchitectureRequest,
  ): Promise<ModuleSpecification> {
    const prompt = `根据变更请求更新模块规格。

当前模块: ${module.name} (${module.id})
模块描述: ${module.description}

变更请求:
- 标题: ${change.title}
- 描述: ${change.description}
- 优先级: ${change.priority}
- 原因: ${change.reason}

当前模块接口:
${JSON.stringify(module.interfaces, null, 2).substring(0, 500)}

当前业务规则:
${JSON.stringify(module.businessRules, null, 2).substring(0, 500)}

请返回更新后的完整模块规格 JSON 对象（格式同 specifyModule 输出）。
只更新受影响的部分，保持其他部分不变。只返回 JSON 对象。`;

    try {
      const response = await this.llm.complete(prompt, '你是一个规格更新专家。根据变更请求更新模块规格。只输出 JSON。');
      const updated = this.parseJSON<ModuleSpecification>(response.content);
      return {
        ...module,
        ...updated,
        id: module.id,
        name: module.name,
      };
    } catch (error) {
      this.logger.warn(`更新模块 ${module.name} 规格失败`, { error });
      return module;
    }
  }

  /**
   * 分析变更影响
   */
  private async analyzeChangeImpact(
    existing: ProjectSpecification,
    change: ChangeRequest,
  ): Promise<{ affectedModules: string[]; impactDescription: string }> {
    const prompt = `分析变更请求对现有规格的影响。

变更请求:
- 标题: ${change.title}
- 描述: ${change.description}
- 受影响模块: ${change.affectedModules.join(', ')}
- 优先级: ${change.priority}

现有模块:
${existing.modules.map((m) => `- ${m.name} (${m.id}): ${m.description}`).join('\n')}

现有依赖图:
${existing.dependencyGraph.edges.map((e) => `${e.from} -> ${e.to} (${e.type})`).join('\n')}

请分析变更的级联影响，返回 JSON 对象:
{
  "affectedModules": ["受影响的模块ID列表（包含间接影响）"],
  "impactDescription": "影响描述（100字以内）"
}

只返回 JSON 对象。`;

    try {
      const response = await this.llm.complete(prompt, '你是一个架构影响分析专家。只输出 JSON。');
      return this.parseJSON<{ affectedModules: string[]; impactDescription: string }>(response.content);
    } catch (error) {
      this.logger.warn('分析变更影响失败', { error });
      return {
        affectedModules: change.affectedModules,
        impactDescription: change.description,
      };
    }
  }

  /**
   * 构建模块依赖图
   */
  private buildDependencyGraph(modules: ModuleSpecification[]): DependencyGraph {
    const nodes: DependencyNode[] = modules.map((m) => ({
      id: m.id,
      name: m.name,
      type: 'module' as const,
      description: m.description,
    }));

    const edges: DependencyEdge[] = [];
    for (const module of modules) {
      for (const dep of module.dependencies) {
        edges.push({
          from: module.id,
          to: dep.moduleId,
          type: dep.type === 'listens_to' ? 'event' : dep.type === 'provides' ? 'data' : 'sync',
          label: dep.description,
        });
      }
    }

    // 计算关键路径（拓扑排序）
    const criticalPath = this.computeCriticalPath(nodes, edges);

    return { nodes, edges, criticalPath };
  }

  /**
   * 计算依赖关键路径（拓扑排序）
   */
  private computeCriticalPath(
    nodes: DependencyNode[],
    edges: DependencyEdge[],
  ): string[] {
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const node of nodes) {
      inDegree.set(node.id, 0);
      adjacency.set(node.id, []);
    }

    for (const edge of edges) {
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
      adjacency.get(edge.from)?.push(edge.to);
    }

    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) {
        queue.push(id);
      }
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      sorted.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    return sorted;
  }

  /**
   * 识别衍生需求
   */
  private async identifyDerivedRequirements(
    request: ArchitectureRequest,
    modules: ModuleSpecification[],
    context: string,
  ): Promise<DerivedRequirementSpec[]> {
    const prompt = `基于架构设计，识别需要用户确认的衍生需求。

项目需求: ${request.requirement.substring(0, 200)}
模块列表: ${modules.map((m) => `${m.name}: ${m.responsibility}`).join('; ')}

${context.substring(0, 600)}

请识别架构设计过程中发现的衍生需求（用户未明确提及但架构需要的），
返回 JSON 数组:
[
  {
    "id": "AR-001",
    "title": "需求标题",
    "description": "需求描述",
    "source": "research|architecture|best_practice",
    "priority": "high|medium|low",
    "status": "pending_confirmation",
    "rationale": "为什么需要这个需求",
    "affectedModules": ["受影响的模块ID"]
  }
]

只返回 JSON 数组。`;

    try {
      const response = await this.llm.complete(prompt, '你是一个需求分析专家。识别衍生需求。只输出 JSON 数组。');
      const requirements = this.parseJSON<DerivedRequirementSpec[]>(response.content);
      if (Array.isArray(requirements)) {
        return requirements;
      }
    } catch (error) {
      this.logger.warn('识别衍生需求失败', { error });
    }

    return [];
  }

  /**
   * 确定技术栈
   */
  private async determineTechStack(
    request: ArchitectureRequest,
    context: string,
  ): Promise<TechStackSpec> {
    // 如果研究报告中有技术推荐，优先使用
    const researchRecs = request.researchReport?.techRecommendations ?? [];

    const prompt = `基于项目需求和架构设计，确定技术栈。

项目需求: ${request.requirement.substring(0, 200)}

${researchRecs.length > 0 ? `研究报告推荐:\n${researchRecs.map((r) => `- [${r.category}] ${r.recommended} (${r.maturity})`).join('\n')}` : ''}

${context.substring(0, 400)}

请返回 JSON 对象:
{
  "frontend": [{"name": "技术名", "version": "版本", "purpose": "用途", "rationale": "选择理由", "alternatives": ["替代方案"]}],
  "backend": [...],
  "database": [...],
  "infrastructure": [...],
  "testing": [...],
  "tooling": [...]
}

只返回 JSON 对象。`;

    try {
      const response = await this.llm.complete(prompt, '你是一个技术架构顾问。确定技术栈。只输出 JSON。');
      return this.parseJSON<TechStackSpec>(response.content);
    } catch (error) {
      this.logger.warn('确定技术栈失败，使用默认技术栈', { error });

      return {
        frontend: [
          { name: 'React', version: '18', purpose: 'UI 框架', rationale: '生态丰富，社区活跃', alternatives: ['Vue', 'Svelte'] },
          { name: 'TypeScript', version: '5', purpose: '类型安全', rationale: '提高代码质量和可维护性', alternatives: ['JavaScript'] },
        ],
        backend: [
          { name: 'Node.js', version: '20', purpose: '运行时', rationale: '与前端统一语言', alternatives: ['Python', 'Go'] },
          { name: 'Express', version: '4', purpose: 'Web 框架', rationale: '轻量灵活', alternatives: ['Fastify', 'Koa'] },
        ],
        database: [
          { name: 'PostgreSQL', version: '15', purpose: '主数据库', rationale: '功能强大，支持 JSON', alternatives: ['MySQL', 'SQLite'] },
        ],
        infrastructure: [
          { name: 'Docker', version: '24', purpose: '容器化', rationale: '标准化部署', alternatives: ['Podman'] },
        ],
        testing: [
          { name: 'Vitest', version: '1', purpose: '单元测试', rationale: '快速，兼容 Jest', alternatives: ['Jest'] },
          { name: 'Playwright', version: '1', purpose: 'E2E 测试', rationale: '跨浏览器支持', alternatives: ['Cypress'] },
        ],
        tooling: [
          { name: 'ESLint', version: '9', purpose: '代码检查', rationale: '行业标准', alternatives: [] },
          { name: 'Prettier', version: '3', purpose: '代码格式化', rationale: '统一风格', alternatives: [] },
        ],
      };
    }
  }

  // ─── File Operations ───────────────────────────────────────────────────

  /**
   * 保存规格文件到文件系统
   */
  private async saveSpecification(spec: ProjectSpecification): Promise<string[]> {
    const artifacts: string[] = [];
    const baseDir = `${this.specOutputDir}/${spec.projectId}`;

    try {
      // 保存完整规格文档
      const specPath = `${baseDir}/specification-v${spec.version}.json`;
      await this.fs.writeFile(specPath, JSON.stringify(spec, null, 2));
      artifacts.push(specPath);

      // 保存最新版本（覆盖）
      const latestPath = `${baseDir}/specification-latest.json`;
      await this.fs.writeFile(latestPath, JSON.stringify(spec, null, 2));
      artifacts.push(latestPath);

      // 保存架构概览（Markdown 格式，便于阅读）
      const overviewPath = `${baseDir}/ARCHITECTURE.md`;
      const overviewMd = this.generateArchitectureMarkdown(spec);
      await this.fs.writeFile(overviewPath, overviewMd);
      artifacts.push(overviewPath);

      // 保存每个模块的独立规格文件
      for (const module of spec.modules) {
        const modulePath = `${baseDir}/modules/${module.name}.json`;
        await this.fs.writeFile(modulePath, JSON.stringify(module, null, 2));
        artifacts.push(modulePath);
      }

      this.logger.info('规格文件已保存', { count: artifacts.length });
    } catch (error) {
      this.logger.warn('保存规格文件失败', { error });
    }

    return artifacts;
  }

  /**
   * 生成架构概览 Markdown 文档
   */
  private generateArchitectureMarkdown(spec: ProjectSpecification): string {
    const lines: string[] = [];

    lines.push(`# ${spec.projectName} - 架构规格文档`);
    lines.push('');
    lines.push(`> 版本: ${spec.version} | 更新时间: ${spec.updatedAt}`);
    lines.push('');
    lines.push('## 需求概述');
    lines.push('');
    lines.push(spec.requirement);
    lines.push('');

    lines.push('## 架构概览');
    lines.push('');
    lines.push(`**模式**: ${spec.architectureOverview.pattern}`);
    lines.push('');
    lines.push(spec.architectureOverview.description);
    lines.push('');

    lines.push('### 架构层次');
    lines.push('');
    for (const layer of spec.architectureOverview.layers) {
      lines.push(`#### ${layer.name}`);
      lines.push(`- 职责: ${layer.responsibility}`);
      lines.push(`- 模块: ${layer.modules.join(', ')}`);
      lines.push(`- 技术: ${layer.technologies.join(', ')}`);
      lines.push('');
    }

    lines.push('## 模块列表');
    lines.push('');
    for (const module of spec.modules) {
      lines.push(`### ${module.name} (${module.id})`);
      lines.push('');
      lines.push(`**描述**: ${module.description}`);
      lines.push(`**职责**: ${module.responsibility}`);
      lines.push('');

      if (module.interfaces.length > 0) {
        lines.push('**接口**:');
        for (const iface of module.interfaces) {
          lines.push(`- ${iface.name}: ${iface.description}`);
          for (const method of iface.methods) {
            lines.push(`  - ${method.name}(${method.parameters.map((p) => p.name).join(', ')}): ${method.returnType}`);
          }
        }
        lines.push('');
      }

      if (module.dependencies.length > 0) {
        lines.push(`**依赖**: ${module.dependencies.map((d) => `${d.moduleId} (${d.type})`).join(', ')}`);
        lines.push('');
      }

      if (module.businessRules.length > 0) {
        lines.push('**业务规则**:');
        for (const rule of module.businessRules) {
          lines.push(`- [${rule.priority}] ${rule.name}: ${rule.description}`);
        }
        lines.push('');
      }
    }

    lines.push('## 依赖图');
    lines.push('');
    lines.push('### 构建顺序（关键路径）');
    lines.push('');
    spec.dependencyGraph.criticalPath.forEach((nodeId, index) => {
      const node = spec.dependencyGraph.nodes.find((n) => n.id === nodeId);
      if (node) {
        lines.push(`${index + 1}. ${node.name} (${nodeId})`);
      }
    });
    lines.push('');

    if (spec.derivedRequirements.length > 0) {
      lines.push('## 衍生需求（待确认）');
      lines.push('');
      for (const req of spec.derivedRequirements) {
        lines.push(`- [${req.priority}] [${req.status}] ${req.title}: ${req.description}`);
        lines.push(`  - 来源: ${req.source} | 依据: ${req.rationale}`);
      }
      lines.push('');
    }

    lines.push('## 变更历史');
    lines.push('');
    for (const change of spec.changeLog) {
      lines.push(`- v${change.version} [${change.type}] ${change.timestamp}: ${change.description}`);
    }
    lines.push('');

    return lines.join('\n');
  }

  // ─── MessageBus Publishing ─────────────────────────────────────────────

  /**
   * 发布架构设计结果到 MessageBus
   */
  private publishArchitectureResult(
    specification: ProjectSpecification,
    correlationId?: string,
  ): void {
    const payload: ArchitectureResultPayload = {
      projectId: specification.projectId,
      projectName: specification.projectName,
      specification,
      correlationId,
    };

    // 发送给 orchestrator
    this.publish('task_completed', 'orchestrator', {
      ...payload,
      taskType: 'architecture',
    } as unknown as Record<string, unknown>, correlationId);

    // 广播给所有构建方
    this.publish('task_completed', 'developer', {
      ...payload,
      taskType: 'architecture',
    } as unknown as Record<string, unknown>, correlationId);

    this.logger.info('架构设计结果已发布', {
      specId: specification.id,
      version: specification.version,
      modules: specification.modules.length,
    });
  }

  // ─── Utility Methods ───────────────────────────────────────────────────

  /**
   * 安全解析 JSON，支持 markdown 代码块包裹
   */
  private parseJSON<T>(text: string): T {
    try {
      return JSON.parse(text) as T;
    } catch {
      const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1].trim()) as T;
      }

      const startBracket = text.indexOf('[') !== -1 ? text.indexOf('[') : text.indexOf('{');
      const endBracket = text.lastIndexOf(']') !== -1 ? text.lastIndexOf(']') : text.lastIndexOf('}');

      if (startBracket !== -1 && endBracket > startBracket) {
        return JSON.parse(text.substring(startBracket, endBracket + 1)) as T;
      }

      throw new Error('无法从文本中提取有效 JSON');
    }
  }

  /**
   * 获取当前规格文档（只读副本）
   */
  getCurrentSpec(): ProjectSpecification | null {
    return this.currentSpec ? JSON.parse(JSON.stringify(this.currentSpec)) : null;
  }

  /**
   * 获取指定版本的规格文档
   */
  async getSpecVersion(projectId: string, version: number): Promise<ProjectSpecification | null> {
    try {
      const specPath = `${this.specOutputDir}/${projectId}/specification-v${version}.json`;
      const exists = await this.fs.exists(specPath);
      if (exists) {
        const content = await this.fs.readFile(specPath);
        return JSON.parse(content) as ProjectSpecification;
      }
    } catch (error) {
      this.logger.warn('读取规格版本失败', { projectId, version, error });
    }
    return null;
  }
}
