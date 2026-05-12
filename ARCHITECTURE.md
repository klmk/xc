# AI Dev Platform - 系统架构文档

## 项目愿景
构建一个AI驱动的全自动化软件工程平台，实现从需求到交付的端到端自动化，支持多AI Agent协作、闭环迭代、人类介入。

## 核心设计原则
1. **场景无关**：通过动态工具链适配任意开发场景
2. **闭环验证**：开发→测试→修复的自动化循环
3. **人类介入**：任何节点可介入，不中断流水线
4. **自举能力**：平台能用于开发自身，实现迭代进化

## 系统架构

```
┌─────────────────────────────────────────┐
│           人类介入接口                    │
│    （命令行/Web/通知，随时查询和干预）      │
└─────────────┬───────────────────────────┘
              ▼
┌─────────────────────────────────────────┐
│           项目经理Agent (Orchestrator)     │
│  - 需求解析                              │
│  - 任务拆解与调度                         │
│  - 状态管理（LangGraph状态机）             │
│  - 人类介入触发                           │
└─────────────┬───────────────────────────┘
              │
    ┌─────────┼─────────┐
    ▼         ▼         ▼
┌───────┐ ┌───────┐ ┌───────┐
│开发Agent│ │测试Agent│ │审查Agent│
│Node.js│ │Node.js│ │Node.js│
└───┬───┘ └───┬───┘ └───┬───┘
    │         │         │
    │    ┌────┴────┐    │
    │    ▼         ▼    │
    │ 单元测试   E2E测试  │
    │    │         │    │
    └────┴────┬────┴────┘
              ▼
┌─────────────────────────────────────────┐
│           执行环境                        │
│  bubblewrap沙箱（代码执行）               │
│  Playwright（E2E测试）                   │
└─────────────────────────────────────────┘
              ▼
┌─────────────────────────────────────────┐
│           存储层                          │
│  本地文件系统 + Git（GitHub）              │
└─────────────────────────────────────────┘
```

## Agent职责定义

### 项目经理Agent
- **输入**：自然语言需求、人类反馈
- **输出**：任务队列、状态报告、介入请求
- **核心能力**：
  - 需求解析与任务拆解
  - Agent调度与协调
  - 状态机管理（LangGraph）
  - 人类介入判断与触发

### 开发Agent
- **输入**：任务描述、上下文、错误反馈
- **输出**：代码文件、单元测试
- **核心能力**：
  - 代码生成（基于DeepSeek V4）
  - 代码修复（基于测试失败反馈）
  - 自我反思与优化

### 测试Agent
- **输入**：需求规范、代码、测试策略
- **输出**：测试报告、Bug列表
- **核心能力**：
  - 单元测试生成与执行
  - E2E测试生成与执行（Playwright）
  - 测试结果分析与反馈生成

### 审查Agent
- **输入**：代码、架构规范
- **输出**：审查报告
- **核心能力**：
  - 代码质量检查
  - 安全审查
  - 性能分析

## 核心工作流

```
需求输入
    ↓
项目经理解析 → 生成任务列表
    ↓
对每个任务循环：
    开发Agent生成代码
        ↓
    代码写入沙箱
        ↓
    测试Agent执行测试（单元+E2E）
        ↓
    ├─ 通过 → 审查Agent检查 → 标记完成
    └─ 失败 → 生成结构化反馈 → 开发Agent修复
        ↓
    （最多3次循环，超过则上报项目经理）
        ↓
任务完成，更新状态，继续下一个
    ↓
所有任务完成 → 最终审查 → 交付
```

## 技术栈

| 组件 | 技术 | 版本 |
|------|------|------|
| 运行时 | Node.js | 20+ |
| 语言 | TypeScript | 5.0+ |
| Agent框架 | LangGraph | 0.2+ |
| LLM | DeepSeek API | V4 |
| 沙箱 | bubblewrap | latest |
| E2E测试 | Playwright | 1.40+ |
| 版本控制 | simple-git | latest |

## 目录结构

```
ai-dev-platform/
├── src/
│   ├── agents/           # Agent实现
│   │   ├── orchestrator.ts   # 项目经理
│   │   ├── developer.ts      # 开发Agent
│   │   ├── tester.ts         # 测试Agent
│   │   └── reviewer.ts       # 审查Agent
│   ├── core/             # 核心逻辑
│   │   ├── state-graph.ts    # LangGraph状态机
│   │   ├── task-queue.ts     # 任务队列
│   │   └── context.ts        # 上下文管理
│   ├── tools/            # 工具集
│   │   ├── llm-client.ts     # DeepSeek接口
│   │   ├── file-system.ts    # 文件操作
│   │   ├── sandbox.ts        # 沙箱管理
│   │   └── git-client.ts     # Git操作
│   ├── tests/            # 测试生成与执行
│   │   ├── unit-test.ts      # 单元测试
│   │   └── e2e-test.ts       # E2E测试(Playwright)
│   └── index.ts          # 入口
├── projects/             # 项目存储（运行时生成）
├── prompts/              # Agent提示词模板
├── package.json
└── tsconfig.json
```

## 状态机设计（LangGraph）

```typescript
// 状态定义
interface ProjectState {
  projectId: string;
  requirement: string;
  tasks: Task[];
  currentTaskIndex: number;
  status: 'idle' | 'analyzing' | 'developing' | 'testing' | 'reviewing' | 'completed' | 'error';
  artifacts: Artifact[];
  humanIntervention?: HumanInterventionRequest;
}

// 节点
- analyzeRequirement: 解析需求
- planTasks: 任务规划
- executeDevelopment: 执行开发
- executeTesting: 执行测试
- executeReview: 执行审查
- handleError: 错误处理
- requestHumanIntervention: 请求人工介入
- complete: 完成

// 边（条件跳转）
- analyzeRequirement → planTasks
- planTasks → executeDevelopment
- executeDevelopment → executeTesting
- executeTesting → executeReview (if pass)
- executeTesting → executeDevelopment (if fail, retry < 3)
- executeTesting → requestHumanIntervention (if fail >= 3)
- executeReview → complete (if pass)
- executeReview → executeDevelopment (if fail)
```

## 沙箱安全设计

使用bubblewrap实现轻量级隔离：
- 文件系统隔离：只暴露项目目录
- 网络隔离：按需开启（安装依赖时需要）
- 资源限制：CPU、内存、执行时间
- 自动清理：执行完毕后销毁

## Git集成策略

```
项目初始化：
  - 创建本地目录
  - git init
  - 关联远程仓库（GitHub）

开发过程中：
  - 每个任务完成自动commit
  - 关键节点自动push
  - 支持回滚到任意提交
```

## 第一个验证项目

**需求**：创建一个简单的待办事项网页应用
- 可以添加待办事项
- 可以删除待办事项
- 可以标记完成/未完成
- 数据持久化（localStorage）

**验证点**：
1. 需求解析准确性
2. 代码生成质量
3. 测试覆盖度
4. 自动修复能力
5. 端到端交付

## 后续演进方向

1. **Phase 1**：最小骨架，验证核心循环
2. **Phase 2**：多Agent并行，复杂项目管理
3. **Phase 3**：自举开发，平台自我迭代
4. **Phase 4**：Firecracker替换bubblewrap，企业级隔离
