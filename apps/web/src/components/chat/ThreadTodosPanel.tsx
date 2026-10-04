import type { EnvironmentId, ProjectId, Todo } from "@t3tools/contracts";
import { TODO_TEXT_MAX_CHARS } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS } from "./threadDetailsPanelStyles";
import { useTodoFocusStore } from "./todoFocusStore";

/**
 * Thread details section for the project's todo list, shared by every checkout
 * of the same repository. Subscribes only while rendered, so the list streams
 * while the details panel is open and is dropped when it closes. Long lists
 * scroll in place so they never fold the rest of the card to compact density.
 */
export function ThreadTodosPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadKey: string;
}) {
  const todosQuery = useEnvironmentQuery(
    serverEnvironment.todosLive({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const createTodo = useAtomCommand(serverEnvironment.createTodo, { label: "todo add" });
  const settleTodo = useAtomCommand(serverEnvironment.settleTodo, { label: "todo settle" });
  const unsettleTodo = useAtomCommand(serverEnvironment.unsettleTodo, { label: "todo unsettle" });
  const removeTodo = useAtomCommand(serverEnvironment.removeTodo, { label: "todo remove" });
  const [draft, setDraft] = useState("");
  const [showSettled, setShowSettled] = useState(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const focusRequested = useTodoFocusStore((state) => state.threadKey === props.threadKey);

  useEffect(() => {
    if (!focusRequested) return;
    useTodoFocusStore.getState().consume();
    // Wait a frame so a closing command palette or opening popover has
    // settled focus before the input takes it.
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusRequested]);

  const list = todosQuery.data;
  const active = list?.todos.filter((todo) => todo.settledAt === null) ?? [];
  const settled = list?.todos.filter((todo) => todo.settledAt !== null) ?? [];
  const settledCount = list?.settledCount ?? 0;

  const reportFailure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const add = async (text: string) => {
    const result = await createTodo({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, text },
    });
    if (result._tag === "Failure") reportFailure("Could not add todo", result);
    return result._tag === "Success";
  };

  const submit = async () => {
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft("");
    if (!(await add(text))) setDraft((current) => (current.length === 0 ? text : current));
  };

  const withBusy = async (todo: Todo, run: () => Promise<void>) => {
    if (busyIds.has(todo.id)) return;
    setBusyIds((current) => new Set(current).add(todo.id));
    await run();
    setBusyIds((current) => {
      const next = new Set(current);
      next.delete(todo.id);
      return next;
    });
  };

  const toggleSettled = (todo: Todo) =>
    withBusy(todo, async () => {
      const input = { environmentId: props.environmentId, input: { todoId: todo.id } };
      const result = await (todo.settledAt === null ? settleTodo(input) : unsettleTodo(input));
      if (result._tag === "Failure") reportFailure("Could not update todo", result);
    });

  const remove = (todo: Todo) =>
    withBusy(todo, async () => {
      const result = await removeTodo({
        environmentId: props.environmentId,
        input: { todoId: todo.id },
      });
      if (result._tag === "Failure") {
        reportFailure("Could not remove todo", result);
        return;
      }
      // Removal is permanent on the server; undo adds the same text back.
      const toastId = toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Todo removed",
          description: todo.text,
          actionProps: {
            children: "Undo",
            onClick: () => {
              toastManager.close(toastId);
              void add(todo.text);
            },
          },
        }),
      );
    });

  const renderTodo = (todo: Todo) => {
    const isSettled = todo.settledAt !== null;
    return (
      <li
        key={todo.id}
        className={cn(
          "group flex min-h-8 items-center rounded-lg py-1",
          THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
        )}
      >
        <Checkbox
          checked={isSettled}
          disabled={busyIds.has(todo.id)}
          aria-label={isSettled ? `Unsettle ${todo.text}` : `Settle ${todo.text}`}
          onCheckedChange={() => void toggleSettled(todo)}
        />
        <span
          className={cn(
            "min-w-0 flex-1 text-sm break-words",
            isSettled ? "text-muted-foreground line-through" : "text-foreground/80",
          )}
        >
          {todo.text}
        </span>
        <span className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100">
          <ThreadDetailsControl
            size="icon-xs"
            variant="ghost"
            part="icon"
            aria-label={`Remove ${todo.text}`}
            disabled={busyIds.has(todo.id)}
            onClick={() => void remove(todo)}
          >
            <XIcon className="size-3.5" />
          </ThreadDetailsControl>
        </span>
      </li>
    );
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-todos-heading"
      title="TODO"
      data-thread-todos-panel
    >
      <div className="px-1">
        <Input
          ref={inputRef}
          size="compact"
          value={draft}
          maxLength={TODO_TEXT_MAX_CHARS}
          placeholder={list ? `Add a todo for ${list.scope.label}` : "Add a todo"}
          aria-label="Add a todo"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void submit();
          }}
        />
      </div>

      {todosQuery.error !== null ? (
        <p className="px-2.5 py-1.5 text-2xs text-destructive">
          Could not load todos: {todosQuery.error}
        </p>
      ) : null}

      {active.length > 0 ? (
        <ul className="m-0 mt-1 max-h-56 list-none overflow-y-auto p-0">
          {active.map(renderTodo)}
        </ul>
      ) : null}

      {settledCount > 0 ? (
        <ThreadDetailsControl
          part="row"
          tone="muted"
          aria-expanded={showSettled}
          onClick={() => setShowSettled((current) => !current)}
        >
          {showSettled ? "Hide settled" : `Show ${settledCount} settled`}
        </ThreadDetailsControl>
      ) : null}

      {showSettled && settled.length > 0 ? (
        <ul className="m-0 max-h-56 list-none overflow-y-auto p-0">{settled.map(renderTodo)}</ul>
      ) : null}
    </ThreadDetailsSection>
  );
}
