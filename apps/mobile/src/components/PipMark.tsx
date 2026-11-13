import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/** Pip, the app's mark, in a single colour. The path is assets/agents/pip.svg. */
export function PipMark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="Ada"
      height={props.height}
      width={(props.height * 62) / 60}
      viewBox="19 16 62 60"
    >
      <ThemedPath
        d="M19 76V46C19 7 81 7 81 46V76H64V64H36V76ZM33 41A5 5 0 0 1 43 41V47A5 5 0 0 1 33 47ZM57 41A5 5 0 0 1 67 41V47A5 5 0 0 1 57 47Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
        fillRule="evenodd"
      />
    </Svg>
  );
}
