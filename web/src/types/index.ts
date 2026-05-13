export type TaskStatus = 'pending' | 'queued' | 'active' | 'ready' | 'done' | 'failed';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  agentId: string;
  agentName: string;
  progress: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface Agent {
  id: string;
  name: string;
  status: 'idle' | 'busy' | 'error';
  currentTask?: string;
}

export interface Message {
  id: string;
  type: string;
  from: string;
  to: string;
  payload: unknown;
  timestamp: string;
}

export interface PlatformState {
  tasks: Task[];
  agents: Agent[];
  messages: Message[];
  connected: boolean;
}
