import { useEffect, useState, useCallback } from 'react';
import type { PlatformState, Task, Agent, Message } from '../types';

// 动态获取 WebSocket URL
function getWebSocketUrl(): string {
  // 如果是开发环境，使用 localhost:4001
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'ws://localhost:4001/ws';
  }
  // 生产环境，使用当前域名
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

// 模拟数据 - 当后端不可用时显示
const mockTasks: Task[] = [
  {
    id: 'task-001',
    title: '实现用户认证模块',
    description: 'JWT 登录、注册、密码重置',
    status: 'done',
    agentId: 'agent-001',
    agentName: 'Builder',
    progress: 100,
    startedAt: '2026-05-13T08:00:00Z',
    completedAt: '2026-05-13T09:30:00Z',
  },
  {
    id: 'task-002',
    title: '开发首页推荐组件',
    description: '轮播图 + 分类列表',
    status: 'active',
    agentId: 'agent-002',
    agentName: 'Builder',
    progress: 65,
    startedAt: '2026-05-13T09:00:00Z',
  },
  {
    id: 'task-003',
    title: '实现电影详情页',
    description: '海报、简介、评分、相关推荐',
    status: 'queued',
    agentId: 'agent-002',
    agentName: 'Builder',
    progress: 0,
  },
  {
    id: 'task-004',
    title: '集成在线播放器',
    description: 'Video.js 播放器集成',
    status: 'pending',
    agentId: 'agent-003',
    agentName: 'Builder',
    progress: 0,
  },
  {
    id: 'task-005',
    title: '编写 E2E 测试',
    description: 'Playwright 自动化测试',
    status: 'ready',
    agentId: 'agent-004',
    agentName: 'Verifier',
    progress: 100,
    startedAt: '2026-05-13T07:00:00Z',
    completedAt: '2026-05-13T08:00:00Z',
  },
];

const mockAgents: Agent[] = [
  { id: 'agent-001', name: 'Orchestrator', status: 'idle' },
  { id: 'agent-002', name: 'Builder', status: 'busy', currentTask: '开发首页推荐组件' },
  { id: 'agent-003', name: 'Builder-2', status: 'idle' },
  { id: 'agent-004', name: 'Verifier', status: 'idle' },
  { id: 'agent-005', name: 'Explorer', status: 'idle' },
  { id: 'agent-006', name: 'Architect', status: 'idle' },
];

const mockMessages: Message[] = [
  {
    id: 'msg-001',
    type: 'task_completed',
    from: 'Builder',
    to: 'Orchestrator',
    payload: { taskId: 'task-001' },
    timestamp: new Date().toISOString(),
  },
  {
    id: 'msg-002',
    type: 'task_assigned',
    from: 'Orchestrator',
    to: 'Builder',
    payload: { taskId: 'task-002' },
    timestamp: new Date().toISOString(),
  },
];

export function useWebSocket() {
  const [state, setState] = useState<PlatformState>({
    tasks: [],
    agents: [],
    messages: [],
    connected: false,
  });

  const connect = useCallback(() => {
    const wsUrl = getWebSocketUrl();
    console.log('Attempting WebSocket connection to:', wsUrl);

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error('Failed to create WebSocket:', err);
      // 使用模拟数据
      setState({
        tasks: mockTasks,
        agents: mockAgents,
        messages: mockMessages,
        connected: false,
      });
      return () => {};
    }

    const connectionTimeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        console.log('WebSocket connection timeout, using mock data');
        ws.close();
        setState((prev) => ({
          ...prev,
          tasks: mockTasks,
          agents: mockAgents,
          messages: mockMessages,
          connected: false,
        }));
      }
    }, 5000);

    ws.onopen = () => {
      clearTimeout(connectionTimeout);
      setState((prev) => ({ ...prev, connected: true }));
      console.log('WebSocket connected');
    };

    ws.onclose = () => {
      clearTimeout(connectionTimeout);
      setState((prev) => ({
        ...prev,
        connected: false,
        // 如果还没有数据，使用模拟数据
        tasks: prev.tasks.length > 0 ? prev.tasks : mockTasks,
        agents: prev.agents.length > 0 ? prev.agents : mockAgents,
        messages: prev.messages.length > 0 ? prev.messages : mockMessages,
      }));
      console.log('WebSocket disconnected, reconnecting...');
      setTimeout(connect, 5000);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleMessage(data);
      } catch (err) {
        console.error('Failed to parse message:', err);
      }
    };

    ws.onerror = (err) => {
      clearTimeout(connectionTimeout);
      console.error('WebSocket error:', err);
      // 使用模拟数据
      setState((prev) => ({
        ...prev,
        tasks: mockTasks,
        agents: mockAgents,
        messages: mockMessages,
        connected: false,
      }));
    };

    return () => {
      clearTimeout(connectionTimeout);
      ws.close();
    };
  }, []);

  const handleMessage = (data: { type: string; payload: unknown }) => {
    switch (data.type) {
      case 'task_assigned':
      case 'task_completed':
      case 'task_failed':
        setState((prev) => ({
          ...prev,
          tasks: updateTasks(prev.tasks, data.type, data.payload as Task),
        }));
        break;
      case 'agent_status':
        setState((prev) => ({
          ...prev,
          agents: data.payload as Agent[],
        }));
        break;
      case 'connected':
        console.log('Server connected:', data.payload);
        break;
      default:
        setState((prev) => ({
          ...prev,
          messages: [...prev.messages.slice(-99), data.payload as Message],
        }));
    }
  };

  useEffect(() => {
    const cleanup = connect();
    return cleanup;
  }, [connect]);

  return state;
}

function updateTasks(tasks: Task[], type: string, payload: Task): Task[] {
  const idx = tasks.findIndex((t) => t.id === payload.id);
  if (idx >= 0) {
    const updated = [...tasks];
    updated[idx] = { ...updated[idx], ...payload };
    return updated;
  }
  return [...tasks, payload];
}
