// @effect-diagnostics nodeBuiltinImport:off -- Runs before the CLI's Effect runtime loads.
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";

// Injected from the brand config by the bundler; this runs before the Effect runtime loads.
declare const __S7VIDEO_APP_ID__: string | undefined;
const BRAND_APP_ID = typeof __S7VIDEO_APP_ID__ === "string" ? __S7VIDEO_APP_ID__ : "s7video-dev";

export function enableCliCompileCache(): void {
  try {
    // AppImage paths change each launch; SEA has no separate modules to cache.
    if (process.env.APPIMAGE || NodeSea.isSea()) return;
    const cacheRoot =
      process.env.XDG_CACHE_HOME ||
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Runs before the CLI's Effect runtime loads.
      (process.platform === "linux" ? NodePath.join(NodeOS.homedir(), ".cache") : NodeOS.tmpdir());
    NodeModule.enableCompileCache(NodePath.join(cacheRoot, BRAND_APP_ID, "compile-cache"));
  } catch {}
}
