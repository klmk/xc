import { useWebSocket } from './hooks/useWebSocket';
import TaskBoard from './components/TaskBoard';
import AgentStatus from './components/AgentStatus';
import MessageLog from './components/MessageLog';
import './App.css';

function App() {
  const { tasks, agents, messages, connected } = useWebSocket();

  const totalTasks = tasks.length;
  const doneTasks = tasks.filter(t => t.status === 'done').length;
  const activeTasks = tasks.filter(t => t.status === 'active').length;
  const failedTasks = tasks.filter(t => t.status === 'failed').length;
  const busyAgents = agents.filter(a => a.status === 'busy').length;

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="header-logo">X</div>
          <h1>AI 开发平台</h1>
          <span className="header-version">v4.0</span>
        </div>
        <div className="header-right">
          <div className="status">
            <span className={`indicator ${connected ? 'connected' : 'disconnected'}`} />
            {connected ? '已连接' : '未连接'}
          </div>
        </div>
      </header>
      <main className="main">
        <aside className="sidebar">
          <AgentStatus agents={agents} />
        </aside>
        <section className="content">
          <div className="stats-bar">
            <div className="stat-item">
              <span className="stat-label">总任务</span>
              <span className="stat-value blue">{totalTasks}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">进行中</span>
              <span className="stat-value yellow">{activeTasks}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">已完成</span>
              <span className="stat-value green">{doneTasks}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">已失败</span>
              <span className="stat-value red">{failedTasks}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">工作中</span>
              <span className="stat-value purple">{busyAgents}</span>
            </div>
          </div>
          <TaskBoard tasks={tasks} />
        </section>
        <aside className="log">
          <MessageLog messages={messages} />
        </aside>
      </main>
    </div>
  );
}

export default App;
