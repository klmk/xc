import type { Message } from '../types';
import './MessageLog.css';

interface Props {
  messages: Message[];
}

function MessageLog({ messages }: Props) {
  return (
    <div className="message-log">
      <h3>消息日志</h3>
      <div className="messages">
        {messages.length === 0 ? (
          <div className="column-empty">暂无消息</div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className="message">
              <span className="msg-type">{msg.type}</span>
              <span className="msg-arrow">→</span>
              <span className="msg-from">{msg.from}</span>
              <span className="msg-time">
                {new Date(msg.timestamp).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default MessageLog;
