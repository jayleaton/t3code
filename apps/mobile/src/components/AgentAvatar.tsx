import type { Icon } from "@tabler/icons-react-native/types";
/* Per-icon imports keep Metro from registering the whole Tabler set. */
import IconCode from "@tabler/icons-react-native/IconCode";
import IconPencil from "@tabler/icons-react-native/IconPencil";
import IconRobot from "@tabler/icons-react-native/IconRobot";
import IconSearch from "@tabler/icons-react-native/IconSearch";
import IconShield from "@tabler/icons-react-native/IconShield";
import IconSparkles from "@tabler/icons-react-native/IconSparkles";
import IconTerminal2 from "@tabler/icons-react-native/IconTerminal2";
import { memo } from "react";
import { View } from "react-native";
import { agentIconKey, type AgentIconKey } from "@t3tools/client-runtime/state/agents";

// Tabler on both platforms, so an agent looks the same as its web/desktop
// (Lucide) glyph instead of the nearest SF Symbol.
const AGENT_GLYPHS = {
  bot: IconRobot,
  code: IconCode,
  pen: IconPencil,
  search: IconSearch,
  shield: IconShield,
  sparkles: IconSparkles,
  terminal: IconTerminal2,
} satisfies Record<Exclude<AgentIconKey, "orb">, Icon>;

/** Deleted agents have no color; a neutral gray reads on light and dark. */
const FALLBACK_COLOR = "#8e8e93";

/** Dark glyphs on the pastel palette, white on saturated or dark picks. */
function glyphColorOn(hex: string) {
  const value = Number.parseInt(hex.slice(1, 7), 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance > 0.36 ? "#1c1c1e" : "#ffffff";
}

/**
 * An agent's icon on a solid disc of its color. "orb", and any icon this
 * build does not know, draws a lit sphere like web's agent orb.
 */
export const AgentAvatar = memo(function AgentAvatar(props: {
  readonly icon: string | null | undefined;
  readonly color: string | null;
  readonly size?: number;
}) {
  const size = props.size ?? 28;
  const color = props.color ?? FALLBACK_COLOR;
  const key = agentIconKey(props.icon);
  const Glyph = key === "orb" ? null : AGENT_GLYPHS[key];
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: color,
        overflow: "hidden",
      }}
    >
      {Glyph ? (
        <Glyph color={glyphColorOn(color)} size={Math.round(size * 0.56)} strokeWidth={2} />
      ) : (
        <View
          style={{
            position: "absolute",
            top: size * 0.14,
            left: size * 0.18,
            width: size * 0.36,
            height: size * 0.36,
            borderRadius: size,
            backgroundColor: "#ffffff",
            opacity: 0.55,
          }}
        />
      )}
    </View>
  );
});
