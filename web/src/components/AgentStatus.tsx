import type { Agent } from '../types';
import './AgentStatus.css';

interface Props {
  agents: Agent[];
}

function AgentStatus({ agents }: Props) {
  return (
    <div className="agent-status">
      <h3>智能体状态</h3>
      <div className="agent-list">
        {agents.length === 0 ? (
          <div className="no-agents">暂无智能体连接</div>
        ) : (
          agents.map((agent) => (
            <div key={agent.id} className={`agent-item ${agent.status}`}>
              <div className="agent-indicator" />
              <div className="agent-info">
                <span className="agent-name">{agent.name}</span>
                <span className="agent-task">{agent.currentTask || '空闲'}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default AgentStatus;
