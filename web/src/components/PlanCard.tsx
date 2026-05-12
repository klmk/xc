import { useState } from 'react';
import { CheckSquare, Square, ClipboardList, Settings, ExternalLink, Clock, Edit3 } from 'lucide-react';
import type { Plan } from '../App';

interface PlanCardProps {
  plan: Plan;
  onConfirm: (plan: Plan) => void;
  onModify: () => void;
}

function PlanCard({ plan, onConfirm, onModify }: PlanCardProps) {
  const [isConfirming, setIsConfirming] = useState(false);

  const p0Features = plan.features.filter((f) => f.priority === 'P0');
  const p1Features = plan.features.filter((f) => f.priority === 'P1');
  const p2Features = plan.features.filter((f) => f.priority === 'P2');

  const handleConfirm = () => {
    setIsConfirming(true);
    setTimeout(() => {
      onConfirm(plan);
      setIsConfirming(false);
    }, 500);
  };

  const statusMap = {
    pending: { label: '待确认', color: '#f59e0b', icon: '🟡' },
    confirmed: { label: '已确认', color: '#10b981', icon: '🟢' },
    modifying: { label: '修改中', color: '#3b82f6', icon: '🔵' },
  };

  const statusInfo = statusMap[plan.status];

  return (
    <div className="plan-card">
      <div className="plan-card-header">
        <div className="plan-card-title">
          <ClipboardList size={18} />
          <span>项目方案</span>
        </div>
        <div className="plan-card-status" style={{ color: statusInfo.color }}>
          {statusInfo.icon} {statusInfo.label}
        </div>
      </div>

      <div className="plan-card-divider" />

      {/* P0 Features */}
      {p0Features.length > 0 && (
        <div className="plan-section">
          <div className="plan-section-title">核心功能（P0）:</div>
          <div className="plan-features">
            {p0Features.map((feature, i) => (
              <div key={i} className="plan-feature">
                {feature.confirmed ? (
                  <CheckSquare size={16} className="feature-check checked" />
                ) : (
                  <Square size={16} className="feature-check" />
                )}
                <span className={feature.confirmed ? 'feature-name confirmed' : 'feature-name'}>
                  {feature.name}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* P1 Features */}
      {p1Features.length > 0 && (
        <div className="plan-section">
          <div className="plan-section-title">增强功能（P1）:</div>
          <div className="plan-features">
            {p1Features.map((feature, i) => (
              <div key={i} className="plan-feature">
                {feature.confirmed ? (
                  <CheckSquare size={16} className="feature-check checked" />
                ) : (
                  <Square size={16} className="feature-check" />
                )}
                <span className={feature.confirmed ? 'feature-name confirmed' : 'feature-name'}>
                  {feature.name}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* P2 Features */}
      {p2Features.length > 0 && (
        <div className="plan-section">
          <div className="plan-section-title">扩展功能（P2）:</div>
          <div className="plan-features">
            {p2Features.map((feature, i) => (
              <div key={i} className="plan-feature">
                {feature.confirmed ? (
                  <CheckSquare size={16} className="feature-check checked" />
                ) : (
                  <Square size={16} className="feature-check" />
                )}
                <span className={feature.confirmed ? 'feature-name confirmed' : 'feature-name'}>
                  {feature.name}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="plan-card-divider" />

      {/* Meta info */}
      <div className="plan-meta">
        <div className="plan-meta-item">
          <Settings size={14} />
          <span>技术方案: <strong>{plan.techStack}</strong></span>
        </div>
        <div className="plan-meta-item">
          <ExternalLink size={14} />
          <span>参考产品: <strong>{plan.reference}</strong></span>
        </div>
        <div className="plan-meta-item">
          <Clock size={14} />
          <span>预估工期: <strong>{plan.estimatedDays}</strong></span>
        </div>
      </div>

      <div className="plan-card-divider" />

      {/* Status */}
      <div className="plan-status-row">
        <span>状态: </span>
        <span style={{ color: statusInfo.color, fontWeight: 600 }}>
          {statusInfo.icon} {statusInfo.label}
        </span>
      </div>

      {/* Actions */}
      {plan.status === 'pending' && (
        <div className="plan-actions">
          <button
            className="btn btn-primary plan-btn"
            onClick={handleConfirm}
            disabled={isConfirming}
          >
            {isConfirming ? (
              <span className="btn-loading">确认中...</span>
            ) : (
              <>
                <CheckSquare size={16} />
                <span>确认方案</span>
              </>
            )}
          </button>
          <button className="btn btn-secondary plan-btn" onClick={onModify}>
            <Edit3 size={16} />
            <span>修改意见</span>
          </button>
        </div>
      )}

      {plan.status === 'confirmed' && (
        <div className="plan-confirmed-badge">
          <CheckSquare size={16} />
          <span>方案已确认，正在开发中...</span>
        </div>
      )}
    </div>
  );
}

export default PlanCard;
