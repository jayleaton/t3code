import { cn } from "~/lib/utils";

/**
 * Fork brand mark (the packaged app icon) shown wherever the T3 wordmark used
 * to sit. The asset is transparent-backed, so callers only control its size.
 */
export function BrandMark({
  alt = "",
  className,
}: {
  alt?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <img
      alt={alt}
      aria-hidden={alt === "" ? true : undefined}
      className={cn("shrink-0 object-contain", className)}
      draggable={false}
      src="/brand-mark.png"
    />
  );
}
