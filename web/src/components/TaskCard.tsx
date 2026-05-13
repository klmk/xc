import type { Task } from '../types';
import './TaskCard.css';

interface Props {
  task: Task;
}

function TaskCard({ task }: Props) {
  return (
    <div className="task-card" data-status={task.status}>
      <div className="task-title">{task.title}</div>
      {task.description && <div className="task-desc">{task.description}</div>}
      <div className="task-meta">
        <span className="agent-tag">{task.agentName}</span>
        {task.progress > 0 && (
          <div className="progress">
            <div className="progress-bar" style={{ width: `${task.progress}%` }} />
          </div>
        )}
      </div>
      {task.error && <div className="task-error">{task.error}</div>}
    </div>
  );
}

export default TaskCard;
