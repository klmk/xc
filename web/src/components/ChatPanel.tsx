import React, { useState, useRef, useEffect } from 'react';
import type { ChatMessage, Task, TaskStatus } from '../types';
import EmptyState from './EmptyState';
import './ChatPanel.css';

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onOpenProgress: () => void;
}

const statusIcon = (status: TaskStatus): string => {
  switch (status) {
    case 'done': return '\u2713';
    case 'active': return '\u25CF';
    default: return '\u25CB';
  }
};

const statusClass = (status: TaskStatus): string => {
  switch (status) {
    case 'done': return 'stage-done';
    case 'active': return 'stage-active';
    default: return 'stage-pending';
  }
};

const ChatPanel: React.FC<ChatPanelProps> = ({ messages, onSend, onOpenProgress }) => {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  };

  const renderProgressCard = (tasks?: Task[]) => {
    if (!tasks || tasks.length === 0) return null;
    return (
      <div className="progress-card" onClick={onOpenProgress}>
        <div className="progress-card-header">
          <span className="progress-card-title">开发进度</span>
          <span className="progress-card-arrow">&rarr;</span>
        </div>
        <div className="progress-stages">
          {tasks.map(task => (
            <div key={task.id} className={`progress-stage ${statusClass(task.status)}`}>
              <span className="stage-icon">{statusIcon(task.status)}</span>
              <span className="stage-name">{task.title}</span>
            </div>
          ))}
        </div>
        <div className="progress-card-footer">点击查看详情</div>
      </div>
    );
  };

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <section className="chat-panel">
      <div className="chat-messages">
        {messages.length === 0 ? (
          <EmptyState icon="💬" title="开始对话" description="输入你的需求，AI 将开始开发" />
        ) : (
          messages.map(msg => (
            <div key={msg.id} className={`chat-message chat-message-${msg.role}`}>
              {msg.role === 'system' ? (
                <div className="system-message">
                  <span className="system-dot" />
                  <span>{msg.content}</span>
                </div>
              ) : (
                <>
                  <div className="message-bubble">
                    <div className="message-content">
                      {msg.content.split('\n').map((line, i) => (
                        <React.Fragment key={i}>
                          {line}
                          {i < msg.content.split('\n').length - 1 && <br />}
                        </React.Fragment>
                      ))}
                    </div>
                    {msg.type === 'progress' && renderProgressCard(msg.progressData)}
                  </div>
                  <div className="message-time">{formatTime(msg.timestamp)}</div>
                </>
              )}
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>
      <div className="chat-input-area">
        <textarea
          ref={textareaRef}
          className="chat-input"
          placeholder="输入你的需求..."
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <button
          className="chat-send-btn"
          onClick={handleSend}
          disabled={!input.trim()}
        >
          发送
        </button>
      </div>
    </section>
  );
};

export default ChatPanel;
