/** Pip, the fork's mark. assets/agents/pip.svg is the only hand-edited source; every brand asset is generated from it. */
export const PIP_SOURCE = "assets/agents/pip.svg";

export const PIP_COLORS = {
  navy: "#111925",
  lavender: "#C5A2FF",
  white: "#FFFFFF",
  black: "#000000",
} as const;

export interface Pip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly d: string;
}

export function parsePip(svg: string): Pip {
  const viewBox = svg
    .match(/viewBox="([^"]+)"/)?.[1]
    ?.split(/\s+/)
    .map(Number);
  const d = svg.match(/<path[^>]*\sd="([^"]+)"/)?.[1];
  if (viewBox?.length !== 4 || viewBox.some(Number.isNaN) || d === undefined) {
    throw new Error(`${PIP_SOURCE} needs a numeric viewBox and one <path d>.`);
  }
  const [x, y, width, height] = viewBox as [number, number, number, number];
  return { x, y, width, height, d };
}

const path = (pip: Pip, fill: string) => `<path fill="${fill}" fill-rule="evenodd" d="${pip.d}"/>`;

/** The glyph alone, cropped to its own bounds. */
export function pipGlyphSvg(pip: Pip, fill: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pip.width}" height="${pip.height}" viewBox="${pip.x} ${pip.y} ${pip.width} ${pip.height}">${path(pip, fill)}</svg>\n`;
}

/**
 * The glyph centred on a square canvas, `fraction` of its width wide. `lift` raises it by that
 * fraction of the canvas, matching the Icon Composer layer offset so every icon sits alike.
 */
export function pipCanvasSvg(
  pip: Pip,
  options: {
    readonly size: number;
    readonly fraction: number;
    readonly fill: string;
    readonly background?: string;
    /** Rounds the background's corners by this fraction of the canvas. */
    readonly cornerRadius?: number;
    readonly lift?: number;
  },
): string {
  const { size, fraction, fill, background, cornerRadius = 0, lift = 0 } = options;
  const scale = (size * fraction) / pip.width;
  const tx = (size - pip.width * scale) / 2 - pip.x * scale;
  const ty = (size - pip.height * scale) / 2 - pip.y * scale - lift * size;
  const backdrop =
    background === undefined
      ? ""
      : `<rect width="${size}" height="${size}" rx="${cornerRadius * size}" fill="${background}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${backdrop}<g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${scale.toFixed(5)})">${path(pip, fill)}</g></svg>`;
}

/** Icon Composer layer offset (points on its 1024pt canvas) that lifts Pip to its optical centre. */
export const PIP_ICON_LIFT = 24 / 1024;
