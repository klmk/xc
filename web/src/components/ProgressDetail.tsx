import React from 'react';
import type { Task, TaskStatus } from '../types';
import './ProgressDetail.css';

interface ProgressDetailProps {
  tasks: Task[];
}

const statusIcon = (status: TaskStatus): string => {
  switch (status) {
    case 'done': return '\u2713';
    case 'active': return '\u25CF';
    default: return '\u25CB';
  }
};

const statusLabel = (status: TaskStatus): string => {
  switch (status) {
    case 'done': return '已完成';
    case 'active': return '进行中';
    case 'queued': return '排队中';
    case 'pending': return '待开始';
    case 'failed': return '失败';
    case 'ready': return '就绪';
  }
};

const statusClass = (status: TaskStatus): string => {
  switch (status) {
    case 'done': return 'pd-done';
    case 'active': return 'pd-active';
    case 'failed': return 'pd-failed';
    default: return 'pd-pending';
  }
};

const ProgressDetail: React.FC<ProgressDetailProps> = ({ tasks }) => {
  const totalProgress = tasks.length > 0
    ? Math.round(tasks.reduce((sum, t) => sum + t.progress, 0) / tasks.length)
    : 0;

  return (
    <div className="progress-detail">
      <div className="pd-overview">
        <div className="pd-overview-header">
          <span className="pd-overview-label">总体进度</span>
          <span className="pd-overview-value">{totalProgress}%</span>
        </div>
        <div className="pd-overview-bar">
          <div className="pd-overview-fill" style={{ width: `${totalProgress}%` }} />
        </div>
      </div>

      <div className="pd-tasks">
        {tasks.map(task => (
          <div key={task.id} className={`pd-task ${statusClass(task.status)}`}>
            <div className="pd-task-header">
              <span className="pd-task-icon">{statusIcon(task.status)}</span>
              <span className="pd-task-name">{task.title}</span>
              <span className="pd-task-status">{statusLabel(task.status)}</span>
              <span className="pd-task-percent">{task.progress}%</span>
            </div>
            {task.description && (
              <div className="pd-task-desc">{task.description}</div>
            )}
            <div className="pd-task-bar">
              <div className="pd-task-fill" style={{ width: `${task.progress}%` }} />
            </div>
            {task.subtasks && task.subtasks.length > 0 && (
              <div className="pd-subtasks">
                {task.subtasks.map(sub => (
                  <div key={sub.id} className={`pd-subtask ${statusClass(sub.status)}`}>
                    <span className="pd-subtask-icon">{statusIcon(sub.status)}</span>
                    <span className="pd-subtask-name">{sub.title}</span>
                    <span className="pd-subtask-percent">{sub.progress}%</span>
                    <div className="pd-subtask-bar">
                      <div className="pd-subtask-fill" style={{ width: `${sub.progress}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="pd-footer">
        <button className="pd-report-btn">查看完整报告</button>
      </div>
    </div>
  );
};

export default ProgressDetail;
