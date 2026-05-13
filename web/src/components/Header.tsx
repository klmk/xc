import React from 'react';
import './Header.css';

interface HeaderProps {
  connected: boolean;
}

const Header: React.FC<HeaderProps> = ({ connected }) => {
  return (
    <header className="header">
      <div className="header-left">
        <div className="header-logo">X</div>
        <h1 className="header-title">AI 开发平台</h1>
        <span className="header-version">v4.0</span>
      </div>
      <div className="header-right">
        <div className={`header-status ${connected ? 'connected' : 'disconnected'}`}>
          <span className="status-dot" />
          <span className="status-text">{connected ? '已连接' : '未连接'}</span>
        </div>
      </div>
    </header>
  );
};

export default Header;
