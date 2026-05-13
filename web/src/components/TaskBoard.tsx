import type { Task } from '../types';
import TaskCard from './TaskCard';
import './TaskBoard.css';

interface Props {
  tasks: Task[];
}

const COLUMNS = [
  { id: 'pending', title: '待处理', color: '#6b7280' },
  { id: 'queued', title: '排队中', color: '#f59e0b' },
  { id: 'active', title: '进行中', color: '#3b82f6' },
  { id: 'ready', title: '待审核', color: '#8b5cf6' },
  { id: 'done', title: '已完成', color: '#10b981' },
  { id: 'failed', title: '已失败', color: '#ef4444' },
];

function TaskBoard({ tasks }: Props) {
  return (
    <div className="task-board">
      {COLUMNS.map((col) => (
        <div key={col.id} className="column">
          <div className="column-header" style={{ borderTopColor: col.color }}>
            <span className="column-title">{col.title}</span>
            <span className="column-count">
              {tasks.filter((t) => t.status === col.id).length}
            </span>
          </div>
          <div className="column-content">
            {tasks
              .filter((t) => t.status === col.id)
              .map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default TaskBoard;
