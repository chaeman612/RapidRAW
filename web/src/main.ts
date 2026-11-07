/**
 * RapidRAW Web entry point: checks browser support, prepares the backend
 * (WebAssembly core, WebGPU device, persisted folders), then boots the regular
 * RapidRAW React app from ../../src.
 */
import { getRenderer } from './backend/editor';
import { initDefaults } from './backend/settings';
import { libraryRoot, restoreRoots } from './backend/vfs';
import { isMobileUi } from './platform';

function showMessage(title: string, lines: string[]) {
  const boot = document.getElementById('rapidraw-web-boot');
  if (!boot) return;
  boot.innerHTML = '';
  const box = document.createElement('div');
  const h = document.createElement('h1');
  h.textContent = title;
  box.appendChild(h);
  for (const line of lines) {
    const p = document.createElement('p');
    p.textContent = line;
    box.appendChild(p);
  }
  boot.appendChild(box);
}

async function boot() {
  if (!('gpu' in navigator)) {
    showMessage('WebGPU is required', [
      'RapidRAW Web renders photos on your GPU with WebGPU, which this browser does not provide.',
      'Please use a recent Chrome, Edge or another Chromium-based browser (Safari 26+ and Firefox 141+ on Windows also work).',
    ]);
    return;
  }
  try {
    await Promise.all([
      getRenderer(),
      initDefaults(),
      restoreRoots().catch(() => []),
      isMobileUi ? libraryRoot() : Promise.resolve(),
    ]);
  } catch (e: any) {
    console.error(e);
    showMessage('RapidRAW Web could not start', [String(e?.message ?? e)]);
    return;
  }
  await import('../../src/main');
  document.getElementById('rapidraw-web-boot')?.remove();
}

function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(new URL('sw.js', document.baseURI))
      .catch((e) => console.warn('Service worker registration failed', e));
  });
}

registerServiceWorker();
boot();
