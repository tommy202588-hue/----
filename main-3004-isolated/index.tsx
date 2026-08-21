import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[AppErrorBoundary]', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', background: '#09090b', color: '#e4e4e7', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ maxWidth: 720, width: '100%', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 12, background: 'rgba(24,24,27,0.96)', padding: 20 }}>
            <div style={{ color: '#f87171', fontWeight: 700, marginBottom: 8 }}>画布加载失败</div>
            <div style={{ color: '#a1a1aa', fontSize: 13, lineHeight: 1.6, marginBottom: 12 }}>页面遇到了一条异常数据或运行错误，已阻止整页黑屏。请刷新重试；如果仍然出现，把下方错误发给我。</div>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 240, overflow: 'auto', background: '#0f0f12', border: '1px solid #27272a', borderRadius: 8, padding: 12, fontSize: 12 }}>{this.state.error.message}</pre>
            <button onClick={() => window.location.reload()} style={{ marginTop: 14, border: 0, borderRadius: 999, background: '#22d3ee', color: '#041316', fontWeight: 700, padding: '8px 14px', cursor: 'pointer' }}>刷新页面</button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
