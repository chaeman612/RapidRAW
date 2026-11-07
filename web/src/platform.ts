/**
 * Decides whether RapidRAW Web runs with the phone/tablet UI.
 *
 * RapidRAW's frontend already ships a touch-first layout for its Android app
 * (compact panels, internal photo library with "Import", selection mode). On
 * phones and tablets the web build reports the platform as "android" so the
 * frontend uses that layout, and the backend serves the Android-only commands
 * from browser storage.
 *
 * Override with `?ui=mobile` or `?ui=desktop` (remembered on this device).
 */

const KEY = 'rapidraw-web-ui';

function readOverride(): 'mobile' | 'desktop' | null {
  try {
    const param = new URLSearchParams(window.location.search).get('ui');
    if (param === 'mobile' || param === 'desktop') {
      localStorage.setItem(KEY, param);
      return param;
    }
    if (param === 'auto') localStorage.removeItem(KEY);
    const stored = localStorage.getItem(KEY);
    return stored === 'mobile' || stored === 'desktop' ? stored : null;
  } catch {
    return null;
  }
}

function detectMobile(): boolean {
  const nav = navigator as any;
  if (nav.userAgentData && typeof nav.userAgentData.mobile === 'boolean' && nav.userAgentData.mobile) return true;
  const ua = navigator.userAgent || '';
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
  // iPadOS reports itself as a Mac with touch support.
  if (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1) return true;
  return false;
}

const override = readOverride();
export const isMobileUi: boolean = override ? override === 'mobile' : detectMobile();

/** True when the File System Access API can open real folders (desktop Chromium). */
export const canOpenFolders = typeof (window as any).showDirectoryPicker === 'function' && !isMobileUi;
