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

export const agentColors = ["#f5b775", "#7bb5ff", "#b797ff", "#71d8bc", "#f293b7"];

/** Stable palette color for an agent, by its position in the full profile list. */
export function agentColorFor(
  profile: McpGatewayProfile,
  profiles: readonly McpGatewayProfile[],
): string {
  if (profile.color) return profile.color;
  const index = profiles.findIndex((item) => item.profileId === profile.profileId);
  return agentColors[(index < 0 ? 0 : index) % agentColors.length]!;
}

export const agentIcons = {
  orb: "Orb",
  bot: "Robot",
  code: "Code",
  pen: "Pen",
  search: "Search",
  shield: "Shield",
  sparkles: "Sparkles",
  terminal: "Terminal",
};
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
  const Icon = icon && icon !== "orb" ? icons[icon] : null;
  return Icon ? (
    <span className="agent-custom-icon" aria-hidden="true">
      <Icon size={20} />
    </span>
  ) : (
    <span className="agent-orb" aria-hidden="true" />
  );
}
