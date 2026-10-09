import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installCustomVisualStyles } from './customVisualStyles';
import '../scie-md/styles/app.css';
import '../scie-md/styles/scientific-document.css';
import './styles.css';
import ibmPlexMonoLicenseUrl from '../scie-md/styles/fonts/vendor/ibm-plex-mono/OFL.txt?url';
import notoSansMonoLicenseUrl from '../scie-md/styles/fonts/vendor/ibm-plex-mono/OFL-Noto-Sans-Mono.txt?url';
import sourceFontManifestUrl from '../scie-md/styles/fonts/vendor/ibm-plex-mono/manifest.json?url';

const root = document.getElementById('root');
document.documentElement.dataset.scieMdBoot = 'running';
document.documentElement.dataset.sourceFontEvidence = JSON.stringify({
  ibmPlexMonoLicenseUrl,
  notoSansMonoLicenseUrl,
  sourceFontManifestUrl,
});
setBootMessage('ScieMD script loaded. Mounting React app...');

window.addEventListener('error', (event) => {
  document.documentElement.dataset.scieMdBoot = 'error';
  setBootMessage(`ScieMD webview error: ${event.message}`);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled ScieMD webview promise rejection:', event.reason);
  event.preventDefault();
  if (document.documentElement.dataset.scieMdBoot === 'mounted') return;
  document.documentElement.dataset.scieMdBoot = 'error';
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  setBootMessage(`ScieMD webview error: ${reason}`);
});

if (root) {
  installCustomVisualStyles();
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
  document.documentElement.dataset.scieMdBoot = 'mounted';
  setBootMessage('ScieMD React app mounted. Waiting for VS Code document...');
} else {
  document.documentElement.dataset.scieMdBoot = 'missing-root';
  setBootMessage('ScieMD webview error: root element was not found.');
}

function setBootMessage(message: string): void {
  const boot = document.getElementById('scie-md-boot');
  if (boot) boot.textContent = message;
}
