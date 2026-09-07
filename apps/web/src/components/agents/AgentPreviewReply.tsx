import { useRef, useState } from "react";
import { ArrowUpIcon } from "lucide-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { composerTargetKey, useComposerDraftStore } from "../../composerDraftStore";
import { useEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { newMessageId } from "../../lib/utils";
import {
  getComposerProviderState,
  getComposerPromptInjectionState,
} from "../chat/composerProviderState";
import { formatOutgoingPrompt } from "../chat/formatOutgoingPrompt";

export function AgentPreviewReply({
  thread,
  onSent,
}: {
  thread: EnvironmentThreadShell;
  onSent: () => void;
}) {
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  const key = composerTargetKey(ref);
  const draft = useComposerDraftStore((store) => store.draftsByThreadKey[key]);
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const prompt = draft?.prompt ?? "";
  const environment = useEnvironment(thread.environmentId);
  const selection =
    (draft?.activeProvider ? draft.modelSelectionByProvider[draft.activeProvider] : null) ??
    thread.modelSelection;
  const provider = environment?.serverConfig?.providers.find(
    (item) => item.instanceId === selection.instanceId,
  );
  const send = useAtomCommand(threadEnvironment.startTurn);
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hasRichDraft = Boolean(
    draft &&
    (draft.images.length ||
      draft.files.length ||
      draft.persistedAttachments.length ||
      draft.nonPersistedImageIds.length ||
      draft.terminalContexts.length ||
      draft.elementContexts.length ||
      draft.previewAnnotations.length ||
      draft.reviewComments.length),
  );
  const unavailable = environment?.connection.phase !== "connected" || !provider;
  const blocked =
    thread.hasPendingApprovals || thread.hasPendingUserInput || thread.hasActionableProposedPlan;
  const disabled = unavailable || hasRichDraft || blocked;
  return (
    <form
      className="agent-preview-reply"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!prompt.trim() || disabled || sending.current || !provider) return;
        const submitted = prompt;
        const interactionMode = draft?.interactionMode ?? thread.interactionMode;
        const providerState = getComposerProviderState({
          provider: provider.driver,
          model: selection.model,
          models: provider.models,
          modelOptions: selection.options,
          planModeEnabled: interactionMode === "plan",
          promptInjectionState: getComposerPromptInjectionState(submitted),
        });
        sending.current = true;
        setBusy(true);
        setError("");
        try {
          const result = await send({
            environmentId: thread.environmentId,
            input: {
              threadId: thread.id,
              message: {
                messageId: newMessageId(),
                role: "user",
                text: formatOutgoingPrompt({
                  provider: provider.driver,
                  model: selection.model,
                  models: provider.models,
                  effort: providerState.promptEffort,
                  text: submitted,
                }),
                attachments: [],
              },
              modelSelection: {
                instanceId: selection.instanceId,
                model: selection.model,
                ...(providerState.modelOptionsForDispatch
                  ? { options: providerState.modelOptionsForDispatch }
                  : {}),
              },
              runtimeMode: draft?.runtimeMode ?? thread.runtimeMode,
              interactionMode,
            },
          });
          if (result._tag === "Success") {
            if (useComposerDraftStore.getState().draftsByThreadKey[key]?.prompt === submitted)
              setPrompt(ref, "");
            onSent();
          } else {
            setError("Message was not sent. Your draft is saved; try again.");
          }
        } finally {
          sending.current = false;
          setBusy(false);
        }
      }}
    >
      <textarea
        aria-label="Reply to chat"
        placeholder="Continue this chat…"
        value={prompt}
        rows={2}
        maxLength={PROVIDER_SEND_TURN_MAX_INPUT_CHARS}
        disabled={busy}
        onChange={(event) => {
          setPrompt(ref, event.target.value);
          setError("");
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <button type="submit" aria-label="Send reply" disabled={disabled || busy || !prompt.trim()}>
        <ArrowUpIcon size={16} />
      </button>
      {(error || unavailable || hasRichDraft || blocked) && (
        <p role="status" className="agent-preview-note">
          {error ||
            (unavailable
              ? "Reconnect to send. Your draft is saved."
              : hasRichDraft
                ? "This draft includes attachments or context. Open chat to send it."
                : "Open chat to respond to the pending request or plan.")}
        </p>
      )}
    </form>
  );
}
