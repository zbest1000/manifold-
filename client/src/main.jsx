import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import App from './App.jsx';
import AuthGate from './components/AuthGate.jsx';
import { initRealtime } from './store/store';
import './index.css';

initRealtime();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthGate>
        <App />
      </AuthGate>
      <Toaster
        position="bottom-right"
        toastOptions={{
          duration: 3500,
          style: {
            background: 'var(--toast-bg)',
            color: 'var(--toast-color)',
            border: '1px solid rgba(255,255,255,0.08)',
            fontSize: '13px'
          }
        }}
      />
    </BrowserRouter>
  </React.StrictMode>
);
