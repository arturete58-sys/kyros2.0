import './polyfill';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { loadStrings } from './i18n';
import { watchInstallPrompt } from './install';
import '@fontsource-variable/geist';
import './styles.css';

watchInstallPrompt();

// Only the visitor's language is downloaded; the first screen waits for it.
void loadStrings().then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);

// Installable app: cache the built files so the next open is instant (production only).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => {});
  });
}
