/** Browser replacement for `@tauri-apps/api/event`. */
import { emit as emitInternal, listen as listenInternal } from '../backend/events';

export type UnlistenFn = () => void;
export type EventCallback<T> = (event: { event: string; payload: T; id: number }) => void;

export async function listen<T = any>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  return listenInternal(event, handler as any);
}

export async function once<T = any>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  const un = listenInternal(event, (e) => {
    un();
    (handler as any)(e);
  });
  return un;
}

export async function emit(event: string, payload?: unknown) {
  emitInternal(event, payload);
}

export async function emitTo(_target: unknown, event: string, payload?: unknown) {
  emitInternal(event, payload);
}

export enum TauriEvent {
  WINDOW_RESIZED = 'tauri://resize',
  WINDOW_CLOSE_REQUESTED = 'tauri://close-requested',
  DRAG_DROP = 'tauri://drag-drop',
}
