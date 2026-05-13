import { useState, useEffect, useCallback, useRef } from 'react';
import type { PlatformState, ChatMessage, Project, Task } from '../types';

const mockProjects: Project[] = [
  {
    id: 'proj-001',
    name: '电影观看平台',
    description: '在线电影浏览和播放平台',
    status: 'active',
    createdAt: '2026-05-13T08:00:00Z',
    previewUrl: 'https://klmk.github.io/xcmove/',
    tasks: [
      { id: 't1', title: '需求分析', description: '分析功能需求和技术方案', status: 'done', agentId: 'a1', agentName: 'Explorer', progress: 100 },
      { id: 't2', title: '架构设计', description: '设计项目架构和模块划分', status: 'done', agentId: 'a2', agentName: 'Architect', progress: 100 },
      { id: 't3', title: '首页开发', description: '轮播图、电影列表、分类导航', status: 'done', agentId: 'a3', agentName: 'Builder', progress: 100 },
      {
        id: 't4', title: '详情页开发', description: '电影详情、评分、推荐', status: 'active', agentId: 'a3', agentName: 'Builder', progress: 65, subtasks: [
          { id: 's1', title: '海报展示', progress: 100, status: 'done' },
          { id: 's2', title: '评分系统', progress: 80, status: 'active' },
          { id: 's3', title: '相关推荐', progress: 20, status: 'active' },
        ],
      },
      { id: 't5', title: '播放器集成', description: 'Video.js播放器', status: 'queued', agentId: 'a3', agentName: 'Builder', progress: 0 },
      { id: 't6', title: '测试验证', description: 'E2E测试和功能验证', status: 'pending', agentId: 'a4', agentName: 'Verifier', progress: 0 },
    ],
  },
  {
    id: 'proj-002',
    name: '待办应用',
    description: '简单的任务管理工具',
    status: 'completed',
    createdAt: '2026-05-12T10:00:00Z',
    tasks: [
      { id: 't7', title: '需求分析', description: '', status: 'done', agentId: 'a1', agentName: 'Explorer', progress: 100 },
      { id: 't8', title: '开发', description: '', status: 'done', agentId: 'a3', agentName: 'Builder', progress: 100 },
      { id: 't9', title: '测试', description: '', status: 'done', agentId: 'a4', agentName: 'Verifier', progress: 100 },
    ],
  },
];

const mockMessages: ChatMessage[] = [
  { id: 'm1', role: 'user', content: '帮我做一个电影观看平台，要有首页推荐、电影详情、搜索功能', timestamp: '2026-05-13T08:00:00Z' },
  { id: 'm2', role: 'assistant', content: '好的，我来分析你的需求并开始开发。首先让我调研一下类似产品的最佳实践...', timestamp: '2026-05-13T08:00:30Z' },
  { id: 'm3', role: 'system', content: 'Explorer 正在调研竞品和最佳实践...', timestamp: '2026-05-13T08:01:00Z', type: 'text' },
  { id: 'm4', role: 'assistant', content: '需求分析完成！我为你规划了以下功能模块：\n\n1. 首页 - 轮播图 + 分类推荐\n2. 电影详情页 - 海报、评分、剧情简介\n3. 搜索页 - 关键词搜索 + 分类筛选\n4. 播放器 - 在线视频播放\n\n现在开始开发，你可以在右侧实时预览效果。', timestamp: '2026-05-13T08:05:00Z' },
  { id: 'm5', role: 'assistant', content: '当前开发进度：', timestamp: '2026-05-13T09:00:00Z', type: 'progress', progressData: mockProjects[0].tasks },
  { id: 'm6', role: 'user', content: '搜索功能加上按年份筛选', timestamp: '2026-05-13T09:30:00Z' },
  { id: 'm7', role: 'assistant', content: '收到，我正在为搜索页添加年份筛选功能。预计3分钟完成。', timestamp: '2026-05-13T09:30:30Z' },
];

const mockAgents = [
  { id: 'a1', name: 'Explorer', status: 'idle' as const },
  { id: 'a2', name: 'Architect', status: 'idle' as const },
  { id: 'a3', name: 'Builder', status: 'busy' as const, currentTask: '详情页开发' },
  { id: 'a4', name: 'Verifier', status: 'idle' as const },
  { id: 'a5', name: 'Reviewer', status: 'idle' as const },
  { id: 'a6', name: 'Deployer', status: 'idle' as const },
];

const initialState: PlatformState = {
  projects: mockProjects,
  currentProject: mockProjects[0],
  messages: mockMessages,
  agents: mockAgents,
  connected: false,
};

function getWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (import.meta.env.DEV) {
    return 'ws://localhost:8080/ws';
  }
  return `${protocol}//${window.location.host}/ws`;
}

export function useWebSocket() {
  const [state, setState] = useState<PlatformState>(initialState);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      connectTimeoutRef.current = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close();
          setState(prev => ({ ...prev, connected: false }));
        }
      }, 5000);

      ws.onopen = () => {
        if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current);
        setState(prev => ({ ...prev, connected: true }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setState(prev => {
            switch (data.type) {
              case 'state':
                return { ...prev, ...data.payload, connected: true };
              case 'message':
                return { ...prev, messages: [...prev.messages, data.payload] };
              case 'project_update':
                return {
                  ...prev,
                  projects: prev.projects.map(p =>
                    p.id === data.payload.id ? { ...p, ...data.payload } : p
                  ),
                  currentProject: prev.currentProject?.id === data.payload.id
                    ? { ...prev.currentProject, ...data.payload }
                    : prev.currentProject,
                };
              default:
                return prev;
            }
          });
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current);
        setState(prev => ({ ...prev, connected: false }));
        reconnectTimerRef.current = setTimeout(connect, 5000);
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      setState(prev => ({ ...prev, connected: false }));
      reconnectTimerRef.current = setTimeout(connect, 5000);
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const sendMessage = useCallback((text: string) => {
    const userMessage: ChatMessage = {
      id: `m-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };

    setState(prev => ({
      ...prev,
      messages: [...prev.messages, userMessage],
    }));

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'message', content: text }));
    }
  }, []);

  return { state, sendMessage };
}
