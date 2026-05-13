import React from 'react';
import type { Project } from '../types';
import './Sidebar.css';

interface SidebarProps {
  projects: Project[];
  currentProject: Project | null;
}

const statusLabels: Record<string, string> = {
  active: '进行中',
  completed: '已完成',
  paused: '已暂停',
};

const statusColors: Record<string, string> = {
  active: 'status-active',
  completed: 'status-completed',
  paused: 'status-paused',
};

const Sidebar: React.FC<SidebarProps> = ({ projects, currentProject }) => {
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="sidebar-section-header">
          <span>项目列表</span>
          <button className="btn-new-project" title="新建项目">+ 新建项目</button>
        </div>
        <div className="project-list">
          {projects.map(project => (
            <div
              key={project.id}
              className={`project-item ${currentProject?.id === project.id ? 'active' : ''}`}
            >
              <div className="project-item-header">
                <span className="project-name">{project.name}</span>
                <span className={`project-status ${statusColors[project.status]}`}>
                  {statusLabels[project.status]}
                </span>
              </div>
              <div className="project-meta">
                {project.tasks.length} 个任务
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="sidebar-bottom">
        <div className="sidebar-section-header">
          <span>快捷功能</span>
        </div>
        <div className="quick-actions">
          <button className="quick-action-btn">
            <span className="quick-action-icon">&#9776;</span>
            <span>进度</span>
          </button>
          <button className="quick-action-btn">
            <span className="quick-action-icon">&#128196;</span>
            <span>文档</span>
          </button>
          <button className="quick-action-btn">
            <span className="quick-action-icon">&#128202;</span>
            <span>报告</span>
          </button>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
