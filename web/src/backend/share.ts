/**
 * Mobile export delivery. Phones have no folder picker, and a plain download
 * buries the photo in "Files". After an export finishes we show a small sheet
 * whose button opens the system share sheet (Save to Photos / Gallery, send to
 * apps), with a regular download as fallback. The share call needs a fresh user
 * gesture, which is why it is a button and not automatic.
 */
import { download } from './vfs';

let host: HTMLDivElement | null = null;

function close() {
  host?.remove();
  host = null;
}

export function offerFiles(files: File[]) {
  if (!files.length) return;
  close();
  const canShare = typeof navigator.share === 'function' && !!navigator.canShare?.({ files });

  host = document.createElement('div');
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-label', 'Exported photos');
  Object.assign(host.style, {
    position: 'fixed',
    left: '0',
    right: '0',
    bottom: '0',
    zIndex: '100000',
    padding: '16px 16px calc(16px + env(safe-area-inset-bottom))',
    background: 'rgba(24,24,24,0.98)',
    borderTop: '1px solid rgba(255,255,255,0.08)',
    boxShadow: '0 -8px 24px rgba(0,0,0,0.4)',
    fontFamily: 'Poppins, system-ui, sans-serif',
    color: '#eee',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  } as CSSStyleDeclaration);

  const title = document.createElement('div');
  title.textContent = files.length === 1 ? `Exported ${files[0].name}` : `Exported ${files.length} photos`;
  Object.assign(title.style, { fontSize: '14px', fontWeight: '600' });
  host.appendChild(title);

  const button = (label: string, primary: boolean, onClick: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    Object.assign(b.style, {
      minHeight: '44px',
      borderRadius: '10px',
      border: primary ? 'none' : '1px solid rgba(255,255,255,0.16)',
      background: primary ? '#fff' : 'transparent',
      color: primary ? '#111' : '#eee',
      fontSize: '15px',
      fontWeight: '600',
      fontFamily: 'inherit',
    } as CSSStyleDeclaration);
    b.addEventListener('click', onClick);
    return b;
  };

  if (canShare) {
    host.appendChild(
      button('Save / Share', true, async () => {
        try {
          await navigator.share({ files });
          close();
        } catch (e: any) {
          if (e?.name !== 'AbortError') console.warn('share failed', e);
        }
      }),
    );
  }
  host.appendChild(
    button(files.length === 1 ? 'Download' : 'Download all', !canShare, () => {
      files.forEach((f) => download(f.name, f));
      close();
    }),
  );
  host.appendChild(button('Close', false, close));
  document.body.appendChild(host);
}
