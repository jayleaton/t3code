# Brand icons

`agents/pip.svg` is the only hand-edited brand source: Ada's mark, Pip. Everything else is generated from it.

The three Icon Composer projects give each release channel its backdrop:

- `dev/app-icon.icon`: blueprint
- `nightly/app-icon.icon`: night sky
- `prod/app-icon.icon`: solid navy

Each project draws Pip from its own `Assets/pip.svg`, which the export writes from `agents/pip.svg` in that channel's colour. Edit the master, not these copies.

Run `vp run icons:export` from the repository root to regenerate the tracked iOS, macOS, Linux, Windows, and web assets, plus the fork's `agents/` set, `apps/web/public/brand-mark.png`, and the marketing favicons, icons, and social card. The development web exports are also copied to `apps/web/public` for the browser favicon and web app manifest icons. Run `vp run icons:check` to verify that every generated asset matches its source without changing files.

Exporting requires Icon Composer 2 or newer on macOS. The script selects the newest compatible exporter from Xcode or a standalone Icon Composer installation and pins design generation 26. Set `ICON_COMPOSER_TOOL` to the full path of `Icon Composer.app/Contents/Executables/ictool` to override automatic discovery. The social card's text uses the system's Helvetica Neue.

Icon Composer's command-line exporter has no `macOS pre-Tahoe` preset; its `macOS` export is full bleed. The export therefore places the rendered icon on Apple's classic safe area, an 824×824 body inset 100 pixels on a 1024×1024 canvas, without Icon Composer's native shadow.

Do not edit the generated PNG, ICO, or WebP files directly.

## Mobile launcher, splash, and widget artwork

`vp run icons:export:android` renders the mobile app's assets from `agents/pip.svg` into `apps/mobile/assets/agents/` and the widget's template mark into `apps/mobile/assets/widget/PipMark.svg`. iOS gets a full-bleed navy square because it applies its own mask. Android masks the central 72dp of a 108dp adaptive canvas and the Android 12+ splash screen masks the central two thirds of a 288dp canvas, so Android gets Pip alone, sized to stay inside those safe zones over a navy background. Every app variant uses the same set.
