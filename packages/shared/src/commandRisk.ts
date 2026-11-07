// Flags shell commands whose damage is hard to undo, so an approval can say what is at stake.
// Adapted from Blast Radius by Hamza Zafar (MIT): https://github.com/hamzafer/claude-code-mods
// This is a warning, not a sandbox: it reads the command text and never blocks or runs anything.

type CommandRiskKind =
  | "recursive-delete"
  | "force-push"
  | "discard-changes"
  | "delete-branch"
  | "database";

interface CommandRisk {
  readonly kind: CommandRiskKind;
  readonly label: string;
  readonly explanation: string;
}

const RISKS: Record<CommandRiskKind, Omit<CommandRisk, "kind">> = {
  "recursive-delete": {
    label: "Deletes files",
    explanation: "Removes files and folders for good. They do not go to the trash.",
  },
  "force-push": {
    label: "Force push",
    explanation:
      "Overwrites the remote branch. Commits only on the remote can be lost for everyone.",
  },
  "discard-changes": {
    label: "Discards changes",
    explanation: "Throws away uncommitted work in this checkout. Git cannot bring it back.",
  },
  "delete-branch": {
    label: "Deletes a branch",
    explanation: "Deletes a branch even if its commits were never merged.",
  },
  database: {
    label: "Database change",
    explanation:
      "Changes or drops database tables. Data removed this way needs a backup to restore.",
  },
};

const MIGRATION =
  /\b(prisma\s+(migrate|db\s+push)|supabase\s+(db\s+(reset|push)|migration\s+up)|drizzle-kit\s+(push|migrate)|knex\s+migrate|sequelize(-cli)?\s+db:migrate|rails\s+db:(migrate|reset|drop)|alembic\s+(upgrade|downgrade)|typeorm\s+migration:run)\b/i;
const DESTRUCTIVE_SQL = /\b(drop\s+(table|database|schema)|truncate\s+(table\s+)?\w)/i;

// Quotes are dropped so a command wrapped in `bash -lc "..."` is read the same as a bare one.
function segments(command: string): string[][] {
  return command
    .replace(/["'`]/g, " ")
    .split(/&&|\|\||[;|\n()]/)
    .map((part) => part.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0);
}

const isShortFlagWith = (word: string, letters: RegExp) =>
  /^-[a-zA-Z]+$/.test(word) && letters.test(word);

function segmentRisk(words: ReadonlyArray<string>): CommandRiskKind | null {
  const rm = words.indexOf("rm");
  if (rm !== -1) {
    const flags = words.slice(rm + 1).filter((word) => word.startsWith("-"));
    if (flags.some((flag) => flag === "--recursive" || isShortFlagWith(flag, /[rR]/))) {
      return "recursive-delete";
    }
  }
  if (words[0] === "find" && words.includes("-delete")) return "recursive-delete";

  const git = words.indexOf("git");
  if (git === -1) return null;
  const args = words.slice(git + 1);
  if (args.includes("push")) {
    if (args.some((arg) => arg === "-f" || arg.startsWith("--force") || /^\+[^+]/.test(arg))) {
      return "force-push";
    }
  }
  if (args.includes("reset") && args.includes("--hard")) return "discard-changes";
  if (
    args.includes("clean") &&
    args.some((arg) => arg === "--force" || isShortFlagWith(arg, /f/))
  ) {
    return "discard-changes";
  }
  if (args.includes("checkout") && (args.includes(".") || args.includes("--"))) {
    return "discard-changes";
  }
  if (args.includes("restore") && !args.includes("--staged")) return "discard-changes";
  if (args.includes("stash") && (args.includes("drop") || args.includes("clear"))) {
    return "discard-changes";
  }
  if (args.includes("branch") && args.some((arg) => arg === "-D" || isShortFlagWith(arg, /D/))) {
    return "delete-branch";
  }
  return null;
}

/** Every distinct risk in the command, in the order they appear. */
export function classifyCommandRisks(command: string): ReadonlyArray<CommandRisk> {
  const kinds = new Set<CommandRiskKind>();
  for (const words of segments(command)) {
    const kind = segmentRisk(words);
    if (kind) kinds.add(kind);
  }
  if (MIGRATION.test(command) || DESTRUCTIVE_SQL.test(command)) kinds.add("database");
  return [...kinds].map((kind) => ({ kind, ...RISKS[kind] }));
}
