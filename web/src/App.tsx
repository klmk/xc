import { useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import ChatPanel from './components/ChatPanel';
import PreviewPanel from './components/PreviewPanel';
import Modal from './components/Modal';
import ProgressDetail from './components/ProgressDetail';
import type { ModalConfig } from './types';
import './App.css';

function App() {
  const { state, sendMessage } = useWebSocket();
  const [modal, setModal] = useState<ModalConfig>({ type: null, title: '' });

  return (
    <div className="app">
      <Header connected={state.connected} />
      <main className="main-layout">
        <Sidebar
          projects={state.projects}
          currentProject={state.currentProject}
        />
        <ChatPanel
          messages={state.messages}
          onSend={sendMessage}
          onOpenProgress={() => setModal({ type: 'progress', title: '开发进度详情', data: state.currentProject?.tasks })}
        />
        <PreviewPanel url={state.currentProject?.previewUrl} />
      </main>
      {modal.type && (
        <Modal title={modal.title} onClose={() => setModal({ type: null, title: '' })}>
          {modal.type === 'progress' && <ProgressDetail tasks={state.currentProject?.tasks || []} />}
        </Modal>
      )}
    </div>
  );
}

export default App;
