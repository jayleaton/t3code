import { create } from "zustand";

/**
 * A pending request, from the command palette or the `todo.add` shortcut, to
 * open a thread's details panel at its todo input. ChatView opens the panel;
 * the todo section focuses its input and consumes the request.
 */
export const useTodoFocusStore = create<{
  readonly threadKey: string | null;
  readonly request: (threadKey: string) => void;
  readonly consume: () => void;
}>()((set) => ({
  threadKey: null,
  request: (threadKey) => set({ threadKey }),
  consume: () => set({ threadKey: null }),
}));
