import {
  BotIcon,
  CodeIcon,
  PenIcon,
  SearchIcon,
  ShieldIcon,
  SparklesIcon,
  TerminalIcon,
} from "lucide-react";
import type { McpGatewayProfile } from "@t3tools/contracts";
import { agentIconKey } from "./agents.logic";

const icons = {
  bot: BotIcon,
  code: CodeIcon,
  pen: PenIcon,
  search: SearchIcon,
  shield: ShieldIcon,
  sparkles: SparklesIcon,
  terminal: TerminalIcon,
};

export function AgentIcon({ icon }: { icon: McpGatewayProfile["icon"] }) {
  const key = agentIconKey(icon);
  const Icon = key === "orb" ? null : icons[key];
  return Icon ? (
    <span className="agent-custom-icon" aria-hidden="true">
      <Icon size={20} />
    </span>
  ) : (
    <span className="agent-orb" aria-hidden="true" />
  );
}
