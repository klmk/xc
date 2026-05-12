import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

// ============================================================
// Types
// ============================================================

interface Project {
  id: string;
  name: string;
  description: string;
  status: 'planning' | 'in_progress' | 'completed' | 'paused';
  lastUpdated: string;
  createdAt: string;
}

interface Plan {
  id: string;
  projectId: string;
  title: string;
  features: {
    name: string;
    priority: 'P0' | 'P1' | 'P2';
    confirmed: boolean;
  }[];
  techStack: string;
  reference: string;
  estimatedDays: string;
  status: 'pending' | 'confirmed' | 'modifying';
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  plan?: Plan;
}

// ============================================================
// Mock Data
// ============================================================

const projects: Project[] = [
  {
    id: 'proj-001',
    name: '在线视频平台',
    description: '类似爱奇艺的在线视频播放平台',
    status: 'in_progress',
    lastUpdated: '2026-05-12T10:30:00Z',
    createdAt: '2026-05-10T08:00:00Z',
  },
  {
    id: 'proj-002',
    name: '电商小程序',
    description: '微信小程序电商平台',
    status: 'planning',
    lastUpdated: '2026-05-11T14:20:00Z',
    createdAt: '2026-05-11T09:00:00Z',
  },
  {
    id: 'proj-003',
    name: '企业官网',
    description: '公司品牌展示官网',
    status: 'completed',
    lastUpdated: '2026-05-08T16:00:00Z',
    createdAt: '2026-05-01T10:00:00Z',
  },
];

const plans: Record<string, Plan> = {
  'proj-001': {
    id: 'plan-001',
    projectId: 'proj-001',
    title: '在线视频平台 - 开发方案',
    features: [
      { name: '首页推荐（轮播 + 分类列表）', priority: 'P0', confirmed: true },
      { name: '电影详情页', priority: 'P0', confirmed: true },
      { name: '在线播放器', priority: 'P0', confirmed: true },
      { name: '搜索功能', priority: 'P0', confirmed: true },
      { name: '收藏/观影历史', priority: 'P1', confirmed: false },
      { name: '评分/评论', priority: 'P1', confirmed: false },
      { name: '用户中心', priority: 'P1', confirmed: false },
      { name: '弹幕功能', priority: 'P2', confirmed: false },
    ],
    techStack: 'React + Node.js + MongoDB',
    reference: '爱奇艺 / Netflix',
    estimatedDays: '3-5天',
    status: 'confirmed',
  },
  'proj-002': {
    id: 'plan-002',
    projectId: 'proj-002',
    title: '电商小程序 - 开发方案',
    features: [
      { name: '商品列表与分类', priority: 'P0', confirmed: true },
      { name: '商品详情页', priority: 'P0', confirmed: true },
      { name: '购物车', priority: 'P0', confirmed: false },
      { name: '订单管理', priority: 'P0', confirmed: false },
      { name: '支付集成', priority: 'P1', confirmed: false },
      { name: '用户评价', priority: 'P1', confirmed: false },
      { name: '优惠券系统', priority: 'P2', confirmed: false },
    ],
    techStack: '微信小程序 + Node.js + MySQL',
    reference: '拼多多 / 京东',
    estimatedDays: '5-7天',
    status: 'pending',
  },
};

// 模拟对话历史
const chatHistories: Record<string, ChatMessage[]> = {
  'proj-001': [
    {
      id: 'msg-001',
      role: 'system',
      content: '项目已创建，项目经理已就绪。',
      timestamp: '2026-05-10T08:00:00Z',
    },
    {
      id: 'msg-002',
      role: 'assistant',
      content: '你好！我是你的AI项目经理。我已经准备好协助你开发「在线视频平台」项目了。\n\n请告诉我你的具体需求，比如：\n- 你希望这个平台有哪些核心功能？\n- 有没有参考的产品？\n- 对技术栈有什么偏好？',
      timestamp: '2026-05-10T08:01:00Z',
    },
    {
      id: 'msg-003',
      role: 'user',
      content: '我想做一个类似爱奇艺的视频平台，需要首页推荐、电影详情页、在线播放器和搜索功能。技术栈用 React + Node.js。',
      timestamp: '2026-05-10T08:05:00Z',
    },
    {
      id: 'msg-004',
      role: 'assistant',
      content: '明白了！我来整理一下你的需求：\n\n1. 首页推荐（轮播图 + 分类列表）\n2. 电影详情页（海报、简介、评分等）\n3. 在线播放器（支持播放/暂停/进度条）\n4. 搜索功能（按名称、分类搜索）\n\n参考产品：爱奇艺 / Netflix\n技术方案：React + Node.js\n\n我正在为你生成详细的开发方案，请稍等...',
      timestamp: '2026-05-10T08:06:00Z',
    },
    {
      id: 'msg-005',
      role: 'assistant',
      content: '开发方案已生成，请查看下方方案卡片，确认后我将开始开发。',
      timestamp: '2026-05-10T08:08:00Z',
      plan: plans['proj-001'],
    },
    {
      id: 'msg-006',
      role: 'user',
      content: '方案看起来不错，确认开始开发吧！',
      timestamp: '2026-05-10T08:10:00Z',
    },
    {
      id: 'msg-007',
      role: 'assistant',
      content: '好的！方案已确认，我现在开始为你搭建项目。\n\n首先创建项目基础结构，配置开发环境...',
      timestamp: '2026-05-10T08:11:00Z',
    },
    {
      id: 'msg-008',
      role: 'system',
      content: '项目正在开发中，当前进度：35%',
      timestamp: '2026-05-12T10:30:00Z',
    },
  ],
  'proj-002': [
    {
      id: 'msg-101',
      role: 'system',
      content: '项目已创建，项目经理已就绪。',
      timestamp: '2026-05-11T09:00:00Z',
    },
    {
      id: 'msg-102',
      role: 'assistant',
      content: '你好！我是你的AI项目经理。我将协助你开发「电商小程序」项目。\n\n请告诉我你的需求，比如：\n- 需要哪些核心功能？\n- 目标用户群体是什么？\n- 有没有参考的竞品？',
      timestamp: '2026-05-11T09:01:00Z',
    },
  ],
  'proj-003': [
    {
      id: 'msg-201',
      role: 'system',
      content: '项目已完成。',
      timestamp: '2026-05-08T16:00:00Z',
    },
    {
      id: 'msg-202',
      role: 'assistant',
      content: '「企业官网」项目已全部完成！\n\n包含以下页面：\n- 首页（公司介绍、产品展示）\n- 关于我们\n- 产品中心\n- 联系我们\n\n部署地址已生成，你可以在线预览。',
      timestamp: '2026-05-08T16:01:00Z',
    },
  ],
};

// ============================================================
// Mock AI Response Generator
// ============================================================

const mockResponses: Record<string, string[]> = {
  greeting: [
    '你好！我是你的AI项目经理，随时准备为你服务。请告诉我你想做什么项目？',
    '嗨！欢迎来到 XC Dev 平台。我可以帮你从零开始构建任何应用。说说你的想法吧！',
  ],
  feature_request: [
    '好的，我已经记录了你的需求。让我分析一下技术可行性和最佳实现方案...\n\n根据我的分析，这个功能完全可行。我建议我们分阶段来实现：\n\n**第一阶段**：搭建基础框架和核心功能\n**第二阶段**：完善交互和优化体验\n**第三阶段**：添加高级功能和性能优化\n\n你觉得这个计划怎么样？',
    '收到！这是一个很好的功能需求。我来为你制定一个详细的开发方案。\n\n我需要确认几个细节：\n1. 这个功能是面向所有用户还是特定用户群体？\n2. 有没有特殊的技术要求或限制？\n3. 预期的用户量级大概是多少？',
  ],
  general: [
    '明白了，我来处理这个需求。请稍等，我正在分析最佳方案...',
    '好的，我已经理解了你的意思。让我整理一下思路，然后给你一个完整的方案。',
    '收到！这个想法很有创意。我来评估一下实现难度和工期，稍后给你反馈。',
    '没问题，这正是我擅长的领域。我会为你设计一个最优的解决方案。',
    '好的，我正在整合你的需求并生成开发方案。这个过程大概需要几秒钟...',
  ],
};

function getMockResponse(userMessage: string): string {
  const msg = userMessage.toLowerCase();

  if (msg.includes('你好') || msg.includes('hi') || msg.includes('hello') || msg.includes('嗨')) {
    return mockResponses.greeting[Math.floor(Math.random() * mockResponses.greeting.length)];
  }

  if (msg.includes('功能') || msg.includes('需要') || msg.includes('实现') || msg.includes('添加')) {
    return mockResponses.feature_request[Math.floor(Math.random() * mockResponses.feature_request.length)];
  }

  return mockResponses.general[Math.floor(Math.random() * mockResponses.general.length)];
}

// ============================================================
// Express Server
// ============================================================

const app = express();
const PORT = 4001;

app.use(cors());
app.use(express.json());

// Serve static files from ../web/dist in production
app.use(express.static(path.join(__dirname, '..', 'web', 'dist')));

// API Routes

// POST /api/chat - Receive user message, return AI response
app.post('/api/chat', (req, res) => {
  const { message, projectId } = req.body;

  if (!message) {
    return res.status(400).json({ error: '消息内容不能为空' });
  }

  const userMsg: ChatMessage = {
    id: uuidv4(),
    role: 'user',
    content: message,
    timestamp: new Date().toISOString(),
  };

  // Store user message
  if (projectId && chatHistories[projectId]) {
    chatHistories[projectId].push(userMsg);
  }

  // Generate mock AI response
  const aiContent = getMockResponse(message);
  const aiMsg: ChatMessage = {
    id: uuidv4(),
    role: 'assistant',
    content: aiContent,
    timestamp: new Date().toISOString(),
  };

  // Store AI message
  if (projectId && chatHistories[projectId]) {
    chatHistories[projectId].push(aiMsg);
  }

  // Simulate delay
  setTimeout(() => {
    res.json({ message: aiMsg });
  }, 800 + Math.random() * 1200);
});

// GET /api/projects - List all projects
app.get('/api/projects', (_req, res) => {
  res.json({ projects });
});

// GET /api/projects/:id/status - Get project status
app.get('/api/projects/:id/status', (req, res) => {
  const { id } = req.params;
  const project = projects.find((p) => p.id === id);

  if (!project) {
    return res.status(404).json({ error: '项目不存在' });
  }

  const plan = plans[id] || null;
  const messages = chatHistories[id] || [];

  res.json({
    project,
    plan,
    messageCount: messages.length,
  });
});

// POST /api/projects/:id/confirm-plan - Confirm a plan
app.post('/api/projects/:id/confirm-plan', (req, res) => {
  const { id } = req.params;
  const plan = plans[id];

  if (!plan) {
    return res.status(404).json({ error: '方案不存在' });
  }

  plan.status = 'confirmed';
  plan.features.forEach((f) => {
    if (f.priority === 'P0') f.confirmed = true;
  });

  // Update project status
  const project = projects.find((p) => p.id === id);
  if (project) {
    project.status = 'in_progress';
    project.lastUpdated = new Date().toISOString();
  }

  // Add system message
  if (chatHistories[id]) {
    chatHistories[id].push({
      id: uuidv4(),
      role: 'system',
      content: '方案已确认，项目开始进入开发阶段。',
      timestamp: new Date().toISOString(),
    });
    chatHistories[id].push({
      id: uuidv4(),
      role: 'assistant',
      content: '方案已确认！我现在开始为你搭建项目。\n\n首先创建项目基础结构，配置开发环境...',
      timestamp: new Date().toISOString(),
    });
  }

  res.json({ success: true, plan });
});

// GET /api/projects/:id/messages - Get chat history
app.get('/api/projects/:id/messages', (req, res) => {
  const { id } = req.params;
  const messages = chatHistories[id] || [];
  res.json({ messages });
});

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'web', 'dist', 'index.html'));
});

// ============================================================
// HTTP Server + WebSocket
// ============================================================

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Track connected clients
const clients = new Map<string, WebSocket>();

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  clients.set(clientId, ws);

  console.log(`[WS] 客户端已连接: ${clientId}`);

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connected',
    clientId,
    message: '已连接到 XC Dev Platform',
  }));

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());

      switch (parsed.type) {
        case 'message': {
          // Chat message from user
          const { content, projectId } = parsed;
          const aiResponse = getMockResponse(content);

          // Simulate agent thinking
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'agent_update',
              projectId,
              message: '🤖 项目经理正在分析需求...',
            }));
          }, 500);

          // Send AI response
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'message',
              role: 'assistant',
              content: aiResponse,
              projectId,
              timestamp: new Date().toISOString(),
            }));
          }, 1500 + Math.random() * 1000);
          break;
        }

        case 'subscribe_project': {
          // Subscribe to project updates
          const { projectId } = parsed;
          ws.send(JSON.stringify({
            type: 'subscribed',
            projectId,
            message: `已订阅项目 ${projectId} 的更新`,
          }));

          // Simulate periodic updates
          const updateInterval = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) {
              clearInterval(updateInterval);
              return;
            }

            const activities = [
              '🤖 项目经理正在编写代码...',
              '🤖 项目经理正在优化页面布局...',
              '🤖 项目经理正在测试功能...',
              '🤖 项目经理正在修复问题...',
              '🤖 项目经理正在部署项目...',
            ];

            ws.send(JSON.stringify({
              type: 'agent_update',
              projectId,
              message: activities[Math.floor(Math.random() * activities.length)],
            }));
          }, 15000);

          // Clean up interval on disconnect
          ws.on('close', () => clearInterval(updateInterval));
          break;
        }

        default:
          console.log(`[WS] 未知消息类型: ${parsed.type}`);
      }
    } catch (err) {
      console.error(`[WS] 消息解析错误:`, err);
    }
  });

  ws.on('close', () => {
    console.log(`[WS] 客户端已断开: ${clientId}`);
    clients.delete(clientId);
  });

  ws.on('error', (err) => {
    console.error(`[WS] 连接错误:`, err);
    clients.delete(clientId);
  });
});

// ============================================================
// Start Server
// ============================================================

server.listen(PORT, () => {
  console.log(`🚀 XC Dev Platform 服务器已启动`);
  console.log(`   HTTP: http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
});
