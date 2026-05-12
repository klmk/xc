import { Wifi, WifiOff, Activity } from 'lucide-react';

interface StatusBarProps {
  agentActivity: string;
  wsConnected: boolean;
  buildStatus: string;
}

function StatusBar({ agentActivity, wsConnected, buildStatus }: StatusBarProps) {
  return (
    <div className="status-bar">
      <div className="status-bar-left">
        {agentActivity && (
          <div className="status-agent-activity">
            <Activity size={14} className="activity-icon" />
            <span>{agentActivity}</span>
          </div>
        )}
      </div>
      <div className="status-bar-right">
        <div className="status-build">
          <span>构建: {buildStatus}</span>
        </div>
        <div className={`status-connection ${wsConnected ? 'connected' : 'disconnected'}`}>
          {wsConnected ? <Wifi size={14} /> : <WifiOff size={14} />}
          <span>{wsConnected ? '已连接' : '未连接'}</span>
        </div>
      </div>
    </div>
  );
}

export default StatusBar;
