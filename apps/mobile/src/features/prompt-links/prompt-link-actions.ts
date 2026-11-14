import * as Dialog from "../../components/ui/Dialog";
import type { LinkedPrompt } from "@t3tools/shared/promptLinks";

import {
  getComposerDraftSnapshot,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { linkedThreadDraftAction } from "./prompt-link-model";

export function showPromptLinkNotice(notice: string): void {
  Dialog.alert("Prompt from a link", notice);
}

export async function applyLinkedPromptToThreadDraft(
  draftKey: string,
  prompt: LinkedPrompt,
  notice: string,
): Promise<void> {
  try {
    await waitForComposerDraftsLoaded();
  } catch {
    Dialog.alert("Could not open link", "Drafts could not be loaded, so the prompt was not added.");
    return;
  }
  const action = linkedThreadDraftAction(getComposerDraftSnapshot(draftKey).text, prompt.text);
  if (action !== "ask") {
    if (action === "fill") setComposerDraftText(draftKey, prompt.text);
    showPromptLinkNotice(notice);
    return;
  }
  Dialog.alert("Linked prompt ready. Replace draft?", notice, [
    { text: "Keep mine", style: "cancel" },
    { text: "Replace", onPress: () => setComposerDraftText(draftKey, prompt.text) },
  ]);
}
