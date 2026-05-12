# AI Dev Platform

AI驱动的全自动化软件工程平台，实现从需求到交付的端到端自动化开发。

## 核心特性

- **多Agent协作**：项目经理、开发、测试、审查Agent协同工作
- **闭环迭代**：开发→测试→修复的自动化循环
- **场景无关**：通过动态工具链适配任意开发场景
- **人类介入**：任何节点可介入，不中断流水线
- **自举能力**：平台能用于开发自身，实现迭代进化

## 系统架构

```
┌─────────────────────────────────────────┐
│           人类介入接口                    │
└─────────────┬───────────────────────────┘
              ▼
┌─────────────────────────────────────────┐
│           项目经理Agent (Orchestrator)     │
│  LangGraph状态机编排                      │
└─────────────┬───────────────────────────┘
              │
    ┌─────────┼─────────┐
    ▼         ▼         ▼
┌───────┐ ┌───────┐ ┌───────┐
│开发Agent│ │测试Agent│ │审查Agent│
└───┬───┘ └───┬───┘ └───┬───┘
    │         │         │
    └─────────┴─────────┘
              ▼
┌─────────────────────────────────────────┐
│           执行环境                        │
│  bubblewrap沙箱 + Playwright E2E测试      │
└─────────────────────────────────────────┘
              ▼
┌─────────────────────────────────────────┐
│           存储层                          │
│  本地文件系统 + Git（GitHub）              │
└─────────────────────────────────────────┘
```

## 技术栈

| 组件 | 技术 |
|------|------|
| 运行时 | Node.js 20+ |
| 语言 | TypeScript 5.0+ |
| Agent框架 | LangGraph 0.2+ |
| LLM | DeepSeek V4 |
| 沙箱 | bubblewrap |
| E2E测试 | Playwright |
| 版本控制 | simple-git |

## 快速开始

### 安装依赖

```bash
npm install
```

### 配置环境变量

```bash
export DEEPSEEK_API_KEY="your-deepseek-api-key"
export GITHUB_TOKEN="your-github-token"  # 可选
export PROJECTS_DIR="./projects"  # 可选
```

### 创建项目

```bash
npm run dev create todo-app "Create a todo list web app with React. Features: add, delete, mark complete. Use localStorage for data persistence."
```

## 核心工作流

```
需求输入
    ↓
项目经理解析 → 生成PRD文档
    ↓
任务规划 → 拆解开发任务
    ↓
循环执行每个任务：
    开发Agent生成代码
        ↓
    代码写入沙箱
        ↓
    测试Agent执行测试（单元+E2E）
        ↓
    ├─ 通过 → 审查Agent检查 → 完成
    └─ 失败 → 生成反馈 → 开发Agent修复
        ↓
    （最多3次循环，超过则上报）
        ↓
任务完成，继续下一个
    ↓
所有任务完成 → 最终审查 → 交付
```

## 项目结构

```
ai-dev-platform/
├── src/
│   ├── agents/           # Agent实现
│   │   ├── orchestrator.ts   # 项目经理
│   │   ├── developer.ts      # 开发Agent
│   │   └── tester.ts         # 测试Agent
│   ├── core/             # 核心逻辑
│   ├── tools/            # 工具集
│   │   ├── llm-client.ts     # DeepSeek接口
│   │   ├── file-system.ts    # 文件操作
│   │   ├── sandbox.ts        # 沙箱管理
│   │   └── git-client.ts     # Git操作
│   ├── tests/            # 测试工具
│   │   └── e2e-test.ts       # Playwright E2E
│   ├── types/            # 类型定义
│   └── index.ts          # 入口
├── projects/             # 生成的项目存储
├── prompts/              # Agent提示词模板
├── ARCHITECTURE.md       # 架构文档
└── README.md
```

## Agent职责

### 项目经理Agent
- 需求解析与任务拆解
- LangGraph状态机管理
- Agent调度与协调
- 人类介入判断与触发

### 开发Agent
- 代码生成（基于DeepSeek V4）
- 代码修复（基于测试反馈）
- 架构设计
- 单元测试生成

### 测试Agent
- 单元测试生成与执行
- E2E测试生成与执行（Playwright）
- 测试结果分析与反馈生成
- 需求符合性验证

## 测试策略

### 分层测试

```
        /\
       /  \     E2E测试（业务场景验证）
      /____\    - Playwright浏览器自动化
     /      \
    /________\  集成测试
   /          \
  /____________\ 单元测试
```

### E2E测试用例生成

从PRD的验收标准（Given-When-Then）自动生成Playwright测试用例，验证业务场景。

## 沙箱安全

使用bubblewrap实现轻量级隔离：
- 文件系统隔离：只暴露项目目录
- 网络隔离：按需开启
- 资源限制：CPU、内存、执行时间
- 自动清理：执行完毕后销毁

## Git集成

- 项目初始化自动创建Git仓库
- 每个任务完成自动commit
- 关键节点自动push到GitHub
- 支持回滚到任意提交

## 人类介入机制

介入触发点：
- 定时汇报（如每30分钟）
- 关键节点完成
- 异常/需要决策
- 主动查询

介入方式：
- 命令行交互
- 状态查询
- 决策确认

## 开发计划

### Phase 1（当前）：最小骨架
- ✅ 核心Agent实现
- ✅ 基础工具链
- ✅ 简单项目验证

### Phase 2：多Agent协作
- 并行任务执行
- 复杂项目管理
- 完善人类介入

### Phase 3：自举开发
- 平台自我迭代
- 自动化改进

### Phase 4：企业级
- Firecracker替换bubblewrap
- 多租户支持
- 完整审计日志

## 贡献

欢迎提交Issue和PR！

## 许可证

MIT