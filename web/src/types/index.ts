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
  subtasks?: SubTask[];
}

export interface SubTask {
  id: string;
  title: string;
  progress: number;
  status: TaskStatus;
}

export interface Agent {
  id: string;
  name: string;
  status: 'idle' | 'busy' | 'error';
  currentTask?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  type?: 'text' | 'progress' | 'error' | 'success';
  progressData?: Task[];
}

export interface Project {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'completed' | 'paused';
  tasks: Task[];
  createdAt: string;
  previewUrl?: string;
}

export interface ModalConfig {
  type: 'progress' | 'code' | 'report' | null;
  title: string;
  data?: unknown;
}

export interface PlatformState {
  projects: Project[];
  currentProject: Project | null;
  messages: ChatMessage[];
  agents: Agent[];
  connected: boolean;
}
