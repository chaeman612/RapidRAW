/** Browser replacement for `@tauri-apps/api/window` (the page is the window). */

const noopUnlisten = () => {};

function makeWindow(label = 'main') {
  const known: Record<string, any> = {
    label,
    isMaximized: async () => true,
    isFullscreen: async () => !!document.fullscreenElement,
    setFullscreen: async (on: boolean) => {
      if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen?.();
      if (!on && document.fullscreenElement) await document.exitFullscreen?.();
    },
    toggleMaximize: async () => {},
    minimize: async () => {},
    close: async () => {},
    setDecorations: async () => {},
    setTitle: async (title: string) => {
      document.title = title;
    },
    scaleFactor: async () => window.devicePixelRatio || 1,
    innerSize: async () => ({ width: window.innerWidth, height: window.innerHeight }),
    outerSize: async () => ({ width: window.innerWidth, height: window.innerHeight }),
    onResized: async (cb: (e: any) => void) => {
      const h = () => cb({ payload: { width: window.innerWidth, height: window.innerHeight } });
      window.addEventListener('resize', h);
      return () => window.removeEventListener('resize', h);
    },
    onCloseRequested: async (cb: (e: any) => void) => {
      const h = (ev: BeforeUnloadEvent) => {
        let prevented = false;
        cb({ preventDefault: () => (prevented = true) });
        if (prevented) ev.preventDefault();
      };
      window.addEventListener('beforeunload', h);
      return () => window.removeEventListener('beforeunload', h);
    },
    onDragDropEvent: async () => noopUnlisten,
    onFocusChanged: async () => noopUnlisten,
    onScaleChanged: async () => noopUnlisten,
    onMoved: async () => noopUnlisten,
    listen: async () => noopUnlisten,
    once: async () => noopUnlisten,
  };
  // Anything else (setSize, center, show, ...) is a harmless async no-op.
  return new Proxy(known, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === 'then') return undefined;
      if (prop.startsWith('on')) return async () => noopUnlisten;
      return async () => undefined;
    },
  });
}

const current = makeWindow('main');

export function getCurrentWindow() {
  return current;
}
export const getCurrent = getCurrentWindow;
export function getAllWindows() {
  return [current];
}
export class Window {
  static getByLabel() {
    return null;
  }
}
export class LogicalSize {
  constructor(
    public width: number,
    public height: number,
  ) {}
}
export class PhysicalSize {
  constructor(
    public width: number,
    public height: number,
  ) {}
}
