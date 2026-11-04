import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { resolveDesktopBaseDir, resolveDesktopStateDir } from "./DesktopStatePaths.ts";

const posixJoin = (...parts: string[]) =>
  parts
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/\/[^/]+\/\.\.\//g, "/");

const homeDirectory = "/Users/someone";
const joinPath = posixJoin;

describe("DesktopStatePaths", () => {
  it("keeps production and development state under ~/.s7video", () => {
    const baseDir = resolveDesktopBaseDir({ homeDirectory, joinPath, t3Home: Option.none() });
    expect(baseDir).toBe("/Users/someone/.s7video");
    expect(
      resolveDesktopStateDir({ baseDir, isDevelopment: false, joinPath, t3Home: Option.none() }),
    ).toBe("/Users/someone/.s7video/userdata");
    expect(
      resolveDesktopStateDir({ baseDir, isDevelopment: true, joinPath, t3Home: Option.none() }),
    ).toBe("/Users/someone/.s7video/dev");
  });

  it("uses an explicit S7VIDEO_HOME as given", () => {
    const t3Home = Option.some(" /tmp/s7video-home ");
    const baseDir = resolveDesktopBaseDir({ homeDirectory, joinPath, t3Home });
    expect(baseDir).toBe("/tmp/s7video-home");
    expect(resolveDesktopStateDir({ baseDir, isDevelopment: true, joinPath, t3Home })).toBe(
      "/tmp/s7video-home/userdata",
    );
  });

  it.each(["/Users/someone/.t3", "/Users/someone/.t3/", "/Users/someone/.t3/../.t3"])(
    "refuses T3 Code's folder %s",
    (configured) => {
      expect(() =>
        resolveDesktopBaseDir({ homeDirectory, joinPath, t3Home: Option.some(configured) }),
      ).toThrow(/T3 Code's data folder/);
    },
  );
});
