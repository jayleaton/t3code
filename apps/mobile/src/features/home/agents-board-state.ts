import { Atom } from "effect/reactivity";

/** One selection survives phone/tablet layout changes and thread navigation. */
export const agentsBoardSelectionAtom = Atom.make<{
  readonly tab: "agents" | "threads";
  readonly profileId: string | null;
}>({ tab: "agents", profileId: null }).pipe(Atom.keepAlive);
