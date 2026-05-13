import React, { useState } from 'react';
import EmptyState from './EmptyState';
import './PreviewPanel.css';

interface PreviewPanelProps {
  url?: string;
}

const PreviewPanel: React.FC<PreviewPanelProps> = ({ url }) => {
  const [refreshKey, setRefreshKey] = useState(0);

  const handleRefresh = () => {
    setRefreshKey(prev => prev + 1);
  };

  const handleFullscreen = () => {
    if (url) {
      window.open(url, '_blank');
    }
  };

  if (!url) {
    return (
      <section className="preview-panel">
        <div className="preview-topbar">
          <span className="preview-title">实时预览</span>
        </div>
        <div className="preview-empty">
          <EmptyState icon="🖥" title="等待项目启动..." description="项目开始开发后，这里将显示实时预览" />
        </div>
      </section>
    );
  }

  return (
    <section className="preview-panel">
      <div className="preview-topbar">
        <span className="preview-title">实时预览</span>
        <div className="preview-actions">
          <button className="preview-btn" onClick={handleRefresh} title="刷新">
            &#8635; 刷新
          </button>
          <button className="preview-btn" onClick={handleFullscreen} title="全屏">
            &#x26F6; 全屏
          </button>
        </div>
      </div>
      <div className="preview-iframe-wrapper">
        <iframe
          key={refreshKey}
          src={url}
          className="preview-iframe"
          title="项目预览"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />
      </div>
    </section>
  );
};

export default PreviewPanel;
