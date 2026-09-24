import React, { Component, ErrorInfo, ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { useCADStore } from './store/cadStore';
import { solidEngine } from './core/3d/SolidEngine';

if (typeof window !== 'undefined') {
  (window as any).__CAD_STORE__ = useCADStore;
  (window as any).__SOLID_ENGINE__ = solidEngine;
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class RootErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('CAD Application Fatal Crash:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="w-screen h-screen bg-neutral-950 text-neutral-100 flex flex-col items-center justify-center p-6 select-none font-sans">
          <div className="max-w-md w-full bg-neutral-900 border border-neutral-800 rounded-lg p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-red-400">
              <svg className="w-6 h-6 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <h2 className="text-lg font-bold">CAD 應用程式執行異常</h2>
            </div>
            <p className="text-xs text-neutral-400">
              應用程式在渲染時發生錯誤。請嘗試重新載入，或重設工作區狀態。
            </p>
            <div className="p-3 bg-neutral-950 border border-neutral-800 rounded text-[11px] font-mono text-red-300 break-all max-h-40 overflow-y-auto">
              {this.state.error?.message || '未知錯誤'}
            </div>
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => window.location.reload()}
                className="flex-1 py-2 px-4 bg-sky-600 hover:bg-sky-500 text-white rounded text-xs font-semibold transition-colors"
              >
                重新載入頁面
              </button>
              <button
                onClick={() => {
                  try {
                    localStorage.clear();
                    sessionStorage.clear();
                  } catch {
                    // ignore
                  }
                  window.location.reload();
                }}
                className="py-2 px-4 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded text-xs font-semibold transition-colors"
              >
                重設快取並重啟
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <RootErrorBoundary>
        <App />
      </RootErrorBoundary>
    </StrictMode>,
  );
}
