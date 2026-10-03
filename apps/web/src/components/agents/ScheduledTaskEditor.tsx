import { useState } from "react";
import {
  defaultScheduledTaskTitle,
  resolveScheduledTaskProfileRouting,
} from "@t3tools/client-runtime/gateway";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  ProjectId,
  type McpGatewayProfile,
  type ScheduledTaskSchedule,
} from "@t3tools/contracts";

import { useClientSettings } from "../../hooks/useSettings";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { type EnvironmentScheduledTask } from "../../state/scheduledTasks";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { agentMachineUnavailableReason } from "./agentMachineAvailability";
import {
  cronToRepeatForm,
  describeSchedule,
  isoToLocalInput,
  localInputToIso,
  localTimeZone,
  repeatFormToCron,
  WEEKDAY_NAMES,
  type RepeatForm,
  type RepeatPreset,
} from "./scheduledTasks.logic";

const REPEAT_PRESETS: ReadonlyArray<readonly [RepeatPreset, string]> = [
  ["daily", "Every day"],
  ["weekdays", "Weekdays"],
  ["weekly", "Every week"],
  ["hourly", "Every hour"],
  ["custom", "Custom (cron)"],
];

/** Compares at the editor's minute precision, so an untouched runAt with seconds is not a change. */
function scheduleChanged(before: ScheduledTaskSchedule, after: ScheduledTaskSchedule): boolean {
  if (before.type === "once" && after.type === "once") {
    return isoToLocalInput(before.runAt) !== isoToLocalInput(after.runAt);
  }
  return JSON.stringify(before) !== JSON.stringify(after);
}

/** The top of the next hour, as a sensible default for a one-time run. */
function nextHourLocalInput(): string {
  const date = new Date();
  date.setHours(date.getHours() + 1, 0, 0, 0);
  return isoToLocalInput(date.toISOString());
}

export function ScheduledTaskEditor({
  task,
  profiles,
  initialProfileId,
  onClose,
}: {
  /** The task to edit, or null to create one. */
  task: EnvironmentScheduledTask | null;
  profiles: ReadonlyArray<McpGatewayProfile>;
  initialProfileId?: string | undefined;
  onClose: () => void;
}) {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const existing = task?.task;
  const [title, setTitle] = useState(existing?.title ?? "");
  const [prompt, setPrompt] = useState(existing?.prompt ?? "");
  const [profileId, setProfileId] = useState(
    existing?.profileId ?? initialProfileId ?? profiles[0]?.profileId ?? "",
  );
  const [chosenMachine, setMachine] = useState<string>(task?.environmentId ?? "");
  const [projectId, setProjectId] = useState<string>(existing?.projectId ?? "");
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  // Interval and fixed-time schedules come from Settings; the editor keeps them as they are.
  const [kind, setKind] = useState<ScheduledTaskSchedule["type"]>(
    existing?.schedule.type ?? "cron",
  );
  const [runAt, setRunAt] = useState(
    existing?.schedule.type === "once"
      ? isoToLocalInput(existing.schedule.runAt)
      : nextHourLocalInput(),
  );
  const [repeat, setRepeat] = useState<RepeatForm>(
    existing?.schedule.type === "cron"
      ? cronToRepeatForm(existing.schedule.expression)
      : { preset: "daily", time: "07:00", weekday: 1, expression: "0 7 * * *" },
  );
  const [timezone, setTimezone] = useState(
    existing?.schedule.type === "cron" ? existing.schedule.timezone : localTimeZone(),
  );
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const upsert = useAtomCommand(serverEnvironment.upsertScheduledTask, { reportFailure: false });

  const profile = profiles.find((item) => item.profileId === profileId);
  const machines = environments
    .filter((env) => env.serverConfig?.environment.capabilities.scheduledTasks === true)
    .map((env) => ({
      env,
      reason: profile ? agentMachineUnavailableReason(profile, env) : undefined,
    }));
  const eligible = machines.filter(({ reason }) => reason === undefined);
  // With a single machine that can run the agent there is nothing to choose.
  const machine = chosenMachine || (eligible.length === 1 ? eligible[0]!.env.environmentId : "");
  const target = machines.find(
    ({ env, reason }) => env.environmentId === machine && reason === undefined,
  )?.env;
  const targetProjects = projects
    .filter((project) => project.environmentId === machine)
    .toSorted((a, b) => a.title.localeCompare(b.title));

  const buildSchedule = (): ScheduledTaskSchedule | string => {
    if (kind === "once") {
      const iso = localInputToIso(runAt);
      return iso === null ? "Pick a date and time." : { type: "once", runAt: iso };
    }
    if (kind !== "cron") {
      return existing?.schedule.type === kind ? existing.schedule : "Choose a schedule.";
    }
    const expression = repeatFormToCron(repeat);
    if (expression === "") return "Enter a cron expression.";
    return { type: "cron", expression, timezone: timezone.trim() || localTimeZone() };
  };

  const save = async () => {
    const schedule = buildSchedule();
    if (typeof schedule === "string") return setError(schedule);
    if (!target || !profile || projectId === "" || prompt.trim() === "") {
      return setError("Choose an agent, machine, and project, and write a prompt.");
    }
    // Existing tasks keep their model and modes until the agent changes.
    const routing =
      existing && profileId === existing.profileId
        ? {
            profileId,
            modelSelection: existing.modelSelection,
            runtimeMode: existing.runtimeMode,
            interactionMode: existing.interactionMode,
          }
        : resolveScheduledTaskProfileRouting(
            profiles,
            profileId,
            target.serverConfig?.providers ?? [],
          );
    if (typeof routing === "string") return setError(routing);
    setSaving(true);
    setError("");
    const trimmedPrompt = prompt.trim();
    const result = await upsert({
      environmentId: EnvironmentId.make(target.environmentId),
      input: {
        ...(existing
          ? { id: existing.id, requireExisting: true, threadId: existing.threadId }
          : {}),
        title: title.trim() || defaultScheduledTaskTitle(trimmedPrompt),
        prompt: trimmedPrompt,
        enabled,
        // Resending an untouched one-time schedule at minute precision would re-arm it.
        schedule:
          existing && !scheduleChanged(existing.schedule, schedule) ? existing.schedule : schedule,
        projectId: ProjectId.make(projectId),
        workspaceStrategy: existing?.workspaceStrategy ?? { type: "root" },
        ...routing,
      },
    });
    setSaving(false);
    if (result._tag === "Success") return onClose();
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : "Could not save the scheduled task.");
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit scheduled task" : "New scheduled task"}</DialogTitle>
          <DialogDescription>
            The agent receives this prompt on schedule. Every run posts into the same thread.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="agent-form">
            <label>
              Prompt
              <textarea
                rows={5}
                value={prompt}
                placeholder="Pull the latest changes from origin and summarise what changed."
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            <label>
              Title
              <input
                value={title}
                placeholder="Defaults to the first line of the prompt"
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <div className="agent-form-grid">
              <label>
                Agent
                <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
                  {profiles.map((item) => (
                    <option
                      key={item.profileId}
                      value={item.profileId}
                      disabled={item.runtimeMode === "read-only"}
                    >
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Machine
                <select
                  value={machine}
                  disabled={existing !== undefined}
                  onChange={(event) => {
                    setMachine(event.target.value);
                    setProjectId("");
                  }}
                >
                  <option value="" disabled>
                    Select machine
                  </option>
                  {machines.map(({ env, reason }) => (
                    <option
                      key={env.environmentId}
                      value={env.environmentId}
                      disabled={reason !== undefined}
                    >
                      {env.label}
                      {reason ? ` — ${reason}` : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Project
              <select
                value={projectId}
                disabled={!target}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="" disabled>
                  Select project
                </option>
                {targetProjects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
            {existing?.threadId &&
              (profileId !== existing.profileId || projectId !== existing.projectId) && (
                <p className="text-xs text-muted-foreground">
                  The next run starts a new thread for the new agent or project.
                </p>
              )}
            <div className="agent-form-grid">
              <label>
                Runs
                <select
                  value={kind}
                  onChange={(event) => setKind(event.target.value as ScheduledTaskSchedule["type"])}
                >
                  <option value="cron">On a schedule</option>
                  <option value="once">Once</option>
                  {(existing?.schedule.type === "interval" ||
                    existing?.schedule.type === "fixed_time") && (
                    <option value={existing.schedule.type}>
                      {describeSchedule(existing.schedule, (iso) =>
                        formatUpcomingTimestamp(iso, timestampFormat),
                      )}
                    </option>
                  )}
                </select>
              </label>
              {kind === "once" ? (
                <label>
                  At
                  <input
                    type="datetime-local"
                    value={runAt}
                    onChange={(event) => setRunAt(event.target.value)}
                  />
                </label>
              ) : kind !== "cron" ? null : (
                <label>
                  Repeat
                  <select
                    value={repeat.preset}
                    onChange={(event) => {
                      const preset = event.target.value as RepeatPreset;
                      setRepeat((current) => ({
                        ...current,
                        preset,
                        expression:
                          preset === "custom" ? repeatFormToCron(current) : current.expression,
                      }));
                    }}
                  >
                    {REPEAT_PRESETS.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {kind === "cron" && (
              <div className="agent-form-grid">
                {repeat.preset === "custom" ? (
                  <label>
                    Cron (minute hour day month weekday)
                    <input
                      value={repeat.expression}
                      placeholder="0 7 * * 1-5"
                      onChange={(event) =>
                        setRepeat((current) => ({ ...current, expression: event.target.value }))
                      }
                    />
                  </label>
                ) : repeat.preset === "hourly" ? (
                  <label>
                    Minute past the hour
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={Number(repeat.time.slice(3))}
                      onChange={(event) =>
                        setRepeat((current) => ({
                          ...current,
                          time: `00:${String(event.target.valueAsNumber || 0).padStart(2, "0")}`,
                        }))
                      }
                    />
                  </label>
                ) : (
                  <label>
                    Time
                    <input
                      type="time"
                      value={repeat.time}
                      onChange={(event) =>
                        setRepeat((current) => ({ ...current, time: event.target.value }))
                      }
                    />
                  </label>
                )}
                {repeat.preset === "weekly" && (
                  <label>
                    Day
                    <select
                      value={repeat.weekday}
                      onChange={(event) =>
                        setRepeat((current) => ({
                          ...current,
                          weekday: Number(event.target.value),
                        }))
                      }
                    >
                      {WEEKDAY_NAMES.map((name, index) => (
                        <option key={name} value={index}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  Time zone
                  <input value={timezone} onChange={(event) => setTimezone(event.target.value)} />
                </label>
              </div>
            )}
            <label className="agent-checkbox-row">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              Enabled
            </label>
            <p className="text-xs text-muted-foreground">
              Runs while the machine's T3 server is up; a run missed while it was off happens once
              when it is back. The agent's permission mode applies, so an agent that asks for
              approvals will wait for you.
            </p>
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={save}>
            {saving ? "Saving…" : existing ? "Save" : "Schedule"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
