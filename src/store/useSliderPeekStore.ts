import { create } from 'zustand';

/**
 * The slider being dragged on a phone. While set, the editor fades its bottom
 * panel out so the whole photo is visible and shows only this label and value.
 */
export interface SliderPeek {
  owner: number;
  label: string;
  value: string;
}

interface SliderPeekState {
  peek: SliderPeek | null;
  setPeek: (peek: SliderPeek) => void;
  clearPeek: (owner: number) => void;
}

export const useSliderPeekStore = create<SliderPeekState>((set, get) => ({
  peek: null,
  setPeek: (peek) => set({ peek }),
  clearPeek: (owner) => {
    if (get().peek?.owner === owner) set({ peek: null });
  },
}));
