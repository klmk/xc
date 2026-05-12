import { Plus, FolderKanban, ChevronRight } from 'lucide-react';
import type { Project } from '../App';

interface SidebarProps {
  projects: Project[];
  activeProjectId: string;
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
}

function getStatusLabel(status: Project['status']): string {
  const map = {
    planning: '规划中',
    in_progress: '开发中',
    completed: '已完成',
    paused: '已暂停',
  };
  return map[status];
}

function getStatusColor(status: Project['status']): string {
  const map = {
    planning: '#f59e0b',
    in_progress: '#3b82f6',
    completed: '#10b981',
    paused: '#6b7280',
  };
  return map[status];
}

function formatLastUpdated(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return '刚刚';
  if (diffMins < 60) return `${diffMins}分钟前`;
  if (diffHours < 24) return `${diffHours}小时前`;
  if (diffDays < 7) return `${diffDays}天前`;
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function Sidebar({ projects, activeProjectId, onSelectProject, onNewProject }: SidebarProps) {
  return (
    <div className="sidebar">
      {/* Logo */}
      <div className="sidebar-logo">
        <div className="logo-icon">
          <FolderKanban size={24} />
        </div>
        <div className="logo-text">
          <h1>XC Dev</h1>
          <span className="logo-subtitle">AI 开发平台</span>
        </div>
      </div>

      {/* Project List */}
      <div className="sidebar-section">
        <div className="sidebar-section-title">项目列表</div>
        <div className="project-list">
          {projects.map((project) => (
            <button
              key={project.id}
              className={`project-item ${project.id === activeProjectId ? 'active' : ''}`}
              onClick={() => onSelectProject(project.id)}
            >
              <div className="project-item-header">
                <div className="project-item-name">{project.name}</div>
                <ChevronRight size={14} className="project-item-arrow" />
              </div>
              <div className="project-item-footer">
                <span
                  className="project-status-badge"
                  style={{
                    backgroundColor: `${getStatusColor(project.status)}20`,
                    color: getStatusColor(project.status),
                  }}
                >
                  {getStatusLabel(project.status)}
                </span>
                <span className="project-item-time">
                  {formatLastUpdated(project.lastUpdated)}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* New Project Button */}
      <div className="sidebar-footer">
        <button className="btn btn-new-project" onClick={onNewProject}>
          <Plus size={18} />
          <span>新建项目</span>
        </button>
      </div>
    </div>
  );
}

export default Sidebar;
