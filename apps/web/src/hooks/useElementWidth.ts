import { useLayoutEffect, useState } from "react";

import { observeResize } from "../lib/observeResize";

/** A callback ref plus the element's content width, null until its first observed size. */
export function useElementWidth<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!element) return;
    return observeResize(element, (entries) => {
      const entry = entries.at(-1);
      if (entry) setWidth(entry.contentRect.width);
    });
  }, [element]);

  return [setElement, width] as const;
}
