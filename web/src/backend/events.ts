/** In-page replacement for Tauri's backend -> frontend event system. */
type Handler = (event: { event: string; payload: any; id: number }) => void;

const listeners = new Map<string, Set<Handler>>();
let nextId = 1;

export function listen(event: string, handler: Handler): () => void {
  let set = listeners.get(event);
  if (!set) listeners.set(event, (set = new Set()));
  set.add(handler);
  return () => set!.delete(handler);
}

export function emit(event: string, payload?: any) {
  const set = listeners.get(event);
  if (!set) return;
  const e = { event, payload, id: nextId++ };
  for (const h of [...set]) {
    try {
      h(e);
    } catch (err) {
      console.error(`listener for ${event} failed`, err);
    }
  }
}
