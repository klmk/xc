// 项目状态定义
export interface ProjectState {
  projectId: string;
  projectName: string;
  requirement: string;
  prd?: PRDDocument;
  tasks: Task[];
  currentTaskIndex: number;
  status: ProjectStatus;
  artifacts: Artifact[];
  humanIntervention?: HumanInterventionRequest;
  createdAt: Date;
  updatedAt: Date;
}

export type ProjectStatus = 
  | 'idle' 
  | 'analyzing' 
  | 'planning'
  | 'developing' 
  | 'testing' 
  | 'reviewing' 
  | 'completed' 
  | 'error'
  | 'waiting_for_human';

// PRD文档
export interface PRDDocument {
  title: string;
  description: string;
  features: Feature[];
  techStack: TechStack;
  acceptanceCriteria: AcceptanceCriterion[];
}

export interface Feature {
  id: string;
  name: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
}

export interface TechStack {
  frontend?: string;
  backend?: string;
  database?: string;
  other?: string[];
}

export interface AcceptanceCriterion {
  id: string;
  given: string;
  when: string;
  then: string;
  featureId: string;
}

// 任务定义
export interface Task {
  id: string;
  type: TaskType;
  title: string;
  description: string;
  status: TaskStatus;
  dependencies: string[];
  maxRetries: number;
  currentRetry: number;
  result?: TaskResult;
  error?: string;
}

export type TaskType = 
  | 'analyze_requirement'
  | 'design_architecture'
  | 'develop_feature'
  | 'write_tests'
  | 'run_tests'
  | 'review_code'
  | 'fix_bug';

export type TaskStatus = 
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'blocked';

export interface TaskResult {
  success: boolean;
  outputs: Record<string, unknown>;
  artifacts: string[];
  logs: string[];
}

// 交付物
export interface Artifact {
  id: string;
  type: ArtifactType;
  name: string;
  path: string;
  content?: string;
  createdAt: Date;
}

export type ArtifactType = 
  | 'code'
  | 'test'
  | 'document'
  | 'config'
  | 'report';

// 人工介入请求
export interface HumanInterventionRequest {
  id: string;
  type: InterventionType;
  message: string;
  context: Record<string, unknown>;
  options?: string[];
  response?: string;
  requestedAt: Date;
  respondedAt?: Date;
}

export type InterventionType = 
  | 'decision_required'
  | 'approval_required'
  | 'clarification_needed'
  | 'error_escalation'
  | 'progress_update';

// Agent定义
export interface AgentConfig {
  name: string;
  role: string;
  systemPrompt: string;
  tools: string[];
  maxIterations: number;
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  metadata?: Record<string, unknown>;
}

// 测试结果
export interface TestResult {
  success: boolean;
  type: 'unit' | 'e2e' | 'integration';
  totalTests: number;
  passedTests: number;
  failedTests: number;
  duration: number;
  logs: string;
  failures: TestFailure[];
}

export interface TestFailure {
  testName: string;
  error: string;
  stackTrace?: string;
}

// 代码文件
export interface CodeFile {
  path: string;
  content: string;
  language: string;
}

// LLM响应
export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// 沙箱配置
export interface SandboxConfig {
  projectPath: string;
  allowedCommands: string[];
  networkEnabled: boolean;
  memoryLimit: string;
  cpuLimit: string;
  timeout: number;
}