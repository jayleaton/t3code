#!/usr/bin/env node

// Mobile launcher, splash and widget assets from Pip (scripts/lib/pip.ts). iOS gets a full-bleed square
// because it applies its own mask; Android gets the glyph alone inside its 66dp safe circle over a navy
// adaptive background, so the launcher mask never crops it. Every app variant uses the same set.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

import {
  parsePip,
  PIP_COLORS,
  PIP_ICON_LIFT,
  PIP_SOURCE,
  pipCanvasSvg,
  pipGlyphSvg,
  type Pip,
} from "./lib/pip.ts";

const ADAPTIVE_CANVAS = 432;
const SPLASH_CANVAS = 1152;
const IOS_CANVAS = 1024;
const SPLASH_MARK_WIDTH = 620;
// Glyph width as a fraction of the canvas: the app icon matches Icon Composer's layer, Android stays inside its safe circle.
const ICON_FRACTION = 0.51;
const ANDROID_FRACTION = 0.4;
const SVG_DENSITY = 300;
const OUTPUT_DIRECTORY = "apps/mobile/assets/agents";
const WIDGET_MARK = "apps/mobile/assets/widget/PipMark.svg";

export class AndroidIconRenderError extends Schema.TaggedError<AndroidIconRenderError>()(
  "AndroidIconRenderError",
  { layer: Schema.String, cause: Schema.Defect() },
) {}

const rasterize = (layer: string, svg: string, width: number, height = width) =>
  Effect.tryPromise({
    try: () =>
      sharp(Buffer.from(svg), { density: SVG_DENSITY }).resize(width, height).png().toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const canvas = (layer: string, pip: Pip, options: Parameters<typeof pipCanvasSvg>[1]) =>
  rasterize(layer, pipCanvasSvg(pip, options), options.size);

const exportAndroidIcons = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const pip = parsePip(yield* fs.readFileString(path.join(repositoryRoot, PIP_SOURCE)));
  const splashMarkHeight = Math.round((SPLASH_MARK_WIDTH * pip.height) / pip.width);

  const outputs: ReadonlyArray<readonly [string, Buffer | string]> = [
    [
      `${OUTPUT_DIRECTORY}/ios-icon-1024.png`,
      yield* canvas("ios-icon", pip, {
        size: IOS_CANVAS,
        fraction: ICON_FRACTION,
        fill: PIP_COLORS.lavender,
        background: PIP_COLORS.navy,
        lift: PIP_ICON_LIFT,
      }),
    ],
    [
      `${OUTPUT_DIRECTORY}/splash-mark.png`,
      yield* rasterize(
        "splash-mark",
        pipGlyphSvg(pip, PIP_COLORS.lavender),
        SPLASH_MARK_WIDTH,
        splashMarkHeight,
      ),
    ],
    [
      `${OUTPUT_DIRECTORY}/android-icon-foreground.png`,
      yield* canvas("android-foreground", pip, {
        size: ADAPTIVE_CANVAS,
        fraction: ANDROID_FRACTION,
        fill: PIP_COLORS.lavender,
      }),
    ],
    [
      `${OUTPUT_DIRECTORY}/android-icon-monochrome.png`,
      yield* canvas("android-monochrome", pip, {
        size: ADAPTIVE_CANVAS,
        fraction: ANDROID_FRACTION,
        fill: PIP_COLORS.white,
      }),
    ],
    [
      `${OUTPUT_DIRECTORY}/android-splash-icon.png`,
      yield* canvas("android-splash", pip, {
        size: SPLASH_CANVAS,
        fraction: ANDROID_FRACTION,
        fill: PIP_COLORS.lavender,
        background: PIP_COLORS.navy,
      }),
    ],
    // A template image: iOS tints it, so only the shape matters.
    [WIDGET_MARK, pipGlyphSvg(pip, PIP_COLORS.black)],
  ];
  for (const [relativePath, contents] of outputs) {
    yield* fs.writeFile(
      path.join(repositoryRoot, relativePath),
      typeof contents === "string" ? new TextEncoder().encode(contents) : contents,
    );
    yield* Console.log(`wrote ${relativePath}`);
  }
});

if (import.meta.main) {
  exportAndroidIcons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
