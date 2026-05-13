import { useEffect, useState, useCallback } from 'react';
import type { PlatformState, Task, Agent, Message } from '../types';

const WS_URL = 'ws://localhost:4001/ws';

export function useWebSocket() {
  const [state, setState] = useState<PlatformState>({
    tasks: [],
    agents: [],
    messages: [],
    connected: false,
  });

  const connect = useCallback(() => {
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      setState((prev) => ({ ...prev, connected: true }));
      console.log('WebSocket connected');
    };

    ws.onclose = () => {
      setState((prev) => ({ ...prev, connected: false }));
      console.log('WebSocket disconnected, reconnecting...');
      setTimeout(connect, 3000);
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
      console.error('WebSocket error:', err);
    };

    return () => ws.close();
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
