import type { Message } from '../types';
import './MessageLog.css';

interface Props {
  messages: Message[];
}

function MessageLog({ messages }: Props) {
  return (
    <div className="message-log">
      <h3>Message Log</h3>
      <div className="messages">
        {messages.map((msg) => (
          <div key={msg.id} className="message">
            <span className="msg-type">{msg.type}</span>
            <span className="msg-from">{msg.from}</span>
            <span className="msg-time">
              {new Date(msg.timestamp).toLocaleTimeString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default MessageLog;
