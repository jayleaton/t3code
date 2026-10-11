import { useEffect, useRef } from "react";
import { View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";

import { SymbolView } from "../../../components/AppSymbol";

/** Pan recognition wins over the settings scroll view only inside the handle. */
export function SettingsDragHandle(props: {
  readonly title: string;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly onStart: () => void;
  readonly onMove: (translation: number) => void;
  readonly onEnd: (translation: number, cancelled: boolean) => void;
  readonly onStep: (direction: "up" | "down") => void;
}) {
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const translation = useRef(0);
  const gesture = usePanGesture({
    minDistance: 0,
    shouldCancelWhenOutside: false,
    runOnJS: true,
    onActivate: () => {
      translation.current = 0;
      latest.current.onStart();
    },
    onUpdate: (event) => {
      translation.current = event.translationY;
      latest.current.onMove(event.translationY);
    },
    onFinalize: (event) => latest.current.onEnd(translation.current, event.canceled),
  });
  return (
    <GestureDetector gesture={gesture}>
      <View
        collapsable={false}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Reorder ${props.title}`}
        accessibilityActions={[
          ...(props.canMoveUp ? [{ name: "decrement", label: "Move up" }] : []),
          ...(props.canMoveDown ? [{ name: "increment", label: "Move down" }] : []),
        ]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (nativeEvent.actionName === "decrement" && props.canMoveUp) props.onStep("up");
          if (nativeEvent.actionName === "increment" && props.canMoveDown) props.onStep("down");
        }}
        style={{ width: 48, alignSelf: "stretch", alignItems: "center", justifyContent: "center" }}
      >
        <SymbolView
          name="line.3.horizontal"
          size={20}
          tintColorClassName="accent-foreground-muted"
        />
      </View>
    </GestureDetector>
  );
}
