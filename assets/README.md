# Brand icons

These are s7video's placeholder icons (ours, a trademark, not MIT; see [TRADEMARK.md](../TRADEMARK.md)).
The folder is the brand config's `icons.directory`. A final design replaces the SVG layers.

The three Icon Composer projects are the source of truth for full application icons:

- `prod/app-icon.icon`: orange, the release icon
- `nightly/app-icon.icon`: dark, for nightly builds
- `dev/app-icon.icon`: light with stripes, for development runs

Each project draws `mark.svg` (the "s7" letters) and `frame.svg` (viewfinder corners) over a solid
fill in the theme colours; the dev project adds `stripes.svg`. Every channel exports the same file
names (`icon-ios-1024.png`, `icon-macos-1024.png`, `icon-universal-1024.png`, `icon-windows.ico` and
the `icon-web-*` favicons and touch icon).

Run `vp run icons:export` from the repository root to regenerate every tracked PNG and ICO. The
development web exports are also copied to `apps/web/public` for the browser favicon and splash
screen. Run `vp run icons:check` to verify that the generated assets and public copies match their
sources without changing files. `pnpm brand:check` fails if an icon is missing or matches one of
the upstream app's icon files.

Exporting requires Icon Composer 2 or newer on macOS. The script selects the newest compatible
exporter from Xcode or a standalone Icon Composer installation and pins design generation 26. Set
`ICON_COMPOSER_TOOL` to the full path of `Icon Composer.app/Contents/Executables/ictool` to override
automatic discovery.

## macOS exports

Icon Composer's command-line exporter has no `macOS pre-Tahoe` preset. The script therefore renders
the icon at 824×824 and centres it on a transparent 1024×1024 canvas with `sips`: the classic macOS
safe area, with the body inset 100 pixels on every side, but without Icon Composer's native shadow.

Do not edit the generated PNG or ICO files directly.
