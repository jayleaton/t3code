import type { EnvironmentId } from "@t3tools/contracts";
import { WandSparklesIcon } from "lucide-react";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Rewrites the draft (often dictated) in Simplified Technical English, with an undo. */
export function ComposerRewriteButton({
  environmentId,
  prompt,
  editPrompt,
}: {
  readonly environmentId: EnvironmentId;
  readonly prompt: string;
  readonly editPrompt: (edit: (current: string) => string) => void;
}) {
  const [pending, setPending] = useState(false);
  const rewrite = useAtomCommand(serverEnvironment.rewriteDraft, {
    label: "Rewrite draft",
    reportFailure: false,
  });
  const original = prompt;

  const run = async () => {
    if (pending || original.trim().length === 0) return;
    setPending(true);
    const result = await rewrite({ environmentId, input: { text: original } });
    setPending(false);
    if (result._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: "Couldn't rewrite the draft",
        description: "Your text is unchanged. Check the text generation model in Settings.",
      });
      return;
    }
    const rewritten = result.value.text;
    if (rewritten.length === 0 || rewritten === original) return;
    // Text typed while the model worked wins over the rewrite.
    let applied = false;
    editPrompt((current) => {
      applied = current === original;
      return applied ? rewritten : current;
    });
    if (!applied) return;
    const id = toastManager.add({
      type: "success",
      title: "Draft rewritten in plain technical English",
      description: "Check it before you send.",
      // Long enough to read the rewrite and still reach Undo.
      timeout: 30_000,
      actionProps: {
        children: "Undo",
        onClick: () => {
          toastManager.close(id);
          editPrompt(() => original);
        },
      },
    });
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={pending || original.trim().length === 0}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => void run()}
            aria-label="Rewrite in plain technical English"
          />
        }
      >
        {pending ? <Spinner /> : <WandSparklesIcon />}
      </TooltipTrigger>
      <TooltipPopup>Rewrite in plain technical English</TooltipPopup>
    </Tooltip>
  );
}
