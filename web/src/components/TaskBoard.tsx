import type { Task } from '../types';
import TaskCard from './TaskCard';
import './TaskBoard.css';

interface Props {
  tasks: Task[];
}

const COLUMNS = [
  { id: 'pending', title: '待处理', color: '#6e7681' },
  { id: 'queued', title: '排队中', color: '#d29922' },
  { id: 'active', title: '进行中', color: '#58a6ff' },
  { id: 'ready', title: '待审核', color: '#bc8cff' },
  { id: 'done', title: '已完成', color: '#3fb950' },
  { id: 'failed', title: '已失败', color: '#f85149' },
];

function TaskBoard({ tasks }: Props) {
  return (
    <div className="task-board">
      {COLUMNS.map((col) => {
        const columnTasks = tasks.filter((t) => t.status === col.id);
        return (
          <div key={col.id} className="column">
            <div className="column-header" style={{ '--col-color': col.color } as React.CSSProperties}>
              <span className="column-title">{col.title}</span>
              <span className="column-count">{columnTasks.length}</span>
            </div>
            <div className="column-content">
              {columnTasks.length === 0 ? (
                <div className="column-empty">暂无任务</div>
              ) : (
                columnTasks.map((task) => (
                  <TaskCard key={task.id} task={task} />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default TaskBoard;
