import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initializeDocumentLanguage } from './i18n/uiMessages.ts';
import { initializeFeedbackDiagnostics } from './services/feedback/browserDiagnostics.ts';
import { initializeDocumentTheme } from './services/preferences/documentTheme.ts';
import './styles/app.css';

initializeDocumentTheme(document.documentElement, window.localStorage);
initializeDocumentLanguage();
initializeFeedbackDiagnostics();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container not found');
}

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
