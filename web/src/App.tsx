import { useWebSocket } from './hooks/useWebSocket';
import TaskBoard from './components/TaskBoard';
import AgentStatus from './components/AgentStatus';
import MessageLog from './components/MessageLog';
import './App.css';

function App() {
  const { tasks, agents, messages, connected } = useWebSocket();

  return (
    <div className="app">
      <header className="header">
        <h1>AI Dev Platform</h1>
        <div className="status">
          <span className={`indicator ${connected ? 'connected' : 'disconnected'}`} />
          {connected ? 'Connected' : 'Disconnected'}
        </div>
      </header>
      <main className="main">
        <aside className="sidebar">
          <AgentStatus agents={agents} />
        </aside>
        <section className="content">
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
