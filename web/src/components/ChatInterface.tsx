import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { Send, Bot, User, Info } from 'lucide-react';
import type { ChatMessage, Project, Plan } from '../App';
import PlanCard from './PlanCard';

interface ChatInterfaceProps {
  project: Project;
  messages: ChatMessage[];
  onSendMessage: (content: string) => void;
  onConfirmPlan: (planId: string) => void;
  onModifyPlan: (feedback: string) => void;
  isLoading: boolean;
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return '今天';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return date.toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
  });
}

function renderContent(content: string) {
  // Simple markdown-like rendering
  const lines = content.split('\n');
  return lines.map((line, i) => {
    // Bold text
    let processed = line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // List items
    if (processed.startsWith('- ')) {
      processed = `<span class="list-bullet">•</span> ${processed.slice(2)}`;
    }
    // Numbered list
    if (/^\d+\.\s/.test(processed)) {
      processed = `<span class="list-number">${processed.match(/^(\d+\.)\s/)?.[1]}</span> ${processed.replace(/^\d+\.\s/, '')}`;
    }

    return (
      <span key={i}>
        <span dangerouslySetInnerHTML={{ __html: processed }} />
        {i < lines.length - 1 && <br />}
      </span>
    );
  });
}

function ChatInterface({
  project,
  messages,
  onSendMessage,
  onConfirmPlan,
  onModifyPlan,
  isLoading,
}: ChatInterfaceProps) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showModifyInput, setShowModifyInput] = useState(false);
  const [modifyText, setModifyText] = useState('');

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 150)}px`;
    }
  }, [input]);

  const handleSend = () => {
    if (!input.trim() || isLoading) return;
    onSendMessage(input.trim());
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleConfirmPlan = (plan: Plan) => {
    onConfirmPlan(plan.id);
  };

  const handleModifyPlan = (feedback: string) => {
    onModifyPlan(feedback);
    setShowModifyInput(false);
    setModifyText('');
  };

  // Group messages by date
  const groupedMessages: { date: string; messages: ChatMessage[] }[] = [];
  let currentDate = '';

  messages.forEach((msg) => {
    const date = formatDate(msg.timestamp);
    if (date !== currentDate) {
      currentDate = date;
      groupedMessages.push({ date, messages: [msg] });
    } else {
      groupedMessages[groupedMessages.length - 1].messages.push(msg);
    }
  });

  return (
    <div className="chat-interface">
      {/* Chat Header */}
      <div className="chat-header">
        <div className="chat-header-left">
          <div className="chat-header-icon">
            <Bot size={20} />
          </div>
          <div>
            <h2 className="chat-header-title">{project.name}</h2>
            <p className="chat-header-desc">{project.description}</p>
          </div>
        </div>
        <div className={`chat-header-status status-${project.status}`}>
          {project.status === 'planning' && '规划中'}
          {project.status === 'in_progress' && '开发中'}
          {project.status === 'completed' && '已完成'}
          {project.status === 'paused' && '已暂停'}
        </div>
      </div>

      {/* Messages Area */}
      <div className="chat-messages">
        {groupedMessages.map((group) => (
          <div key={group.date} className="message-group">
            <div className="message-date-divider">
              <span>{group.date}</span>
            </div>
            {group.messages.map((msg) => (
              <div key={msg.id} className={`message-wrapper message-${msg.role}`}>
                {msg.role === 'assistant' && (
                  <div className="message-avatar">
                    <Bot size={18} />
                  </div>
                )}
                {msg.role === 'user' && (
                  <div className="message-avatar user-avatar">
                    <User size={18} />
                  </div>
                )}
                <div className={`message-bubble message-bubble-${msg.role}`}>
                  {msg.role === 'system' ? (
                    <div className="system-message">
                      <Info size={14} />
                      <span>{msg.content}</span>
                    </div>
                  ) : (
                    <>
                      <div className="message-content">{renderContent(msg.content)}</div>
                      <div className="message-time">{formatTime(msg.timestamp)}</div>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}

        {/* Plan Card in modify mode */}
        {showModifyInput && (
          <div className="modify-input-wrapper">
            <div className="modify-input-card">
              <h4>请输入修改意见</h4>
              <textarea
                value={modifyText}
                onChange={(e) => setModifyText(e.target.value)}
                placeholder="请描述你希望修改的内容..."
                rows={3}
                className="modify-textarea"
              />
              <div className="modify-input-actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setShowModifyInput(false);
                    setModifyText('');
                  }}
                >
                  取消
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => handleModifyPlan(modifyText)}
                  disabled={!modifyText.trim()}
                >
                  提交意见
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Loading indicator */}
        {isLoading && (
          <div className="message-wrapper message-assistant">
            <div className="message-avatar">
              <Bot size={18} />
            </div>
            <div className="message-bubble message-bubble-assistant">
              <div className="typing-indicator">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="chat-input-area">
        <div className="chat-input-container">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入你的需求，按 Enter 发送..."
            rows={1}
            className="chat-input"
            disabled={isLoading}
          />
          <button
            className={`chat-send-btn ${input.trim() ? 'active' : ''}`}
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
          >
            <Send size={18} />
          </button>
        </div>
        <div className="chat-input-hint">
          按 Enter 发送，Shift + Enter 换行
        </div>
      </div>
    </div>
  );
}

export default ChatInterface;
