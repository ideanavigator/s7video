import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { MAC_PERMISSION_HELPER_CHANNEL } from "../ipc/channels.ts";
import { MacPermissionHelper } from "./MacPermissionHelper.ts";
import type { SettingsWindow } from "./MacSettingsWindow.ts";

const mocks = vi.hoisted(() => ({
  granted: false,
  createFromPath: vi.fn(),
  startDrag: vi.fn(),
  showItemInFolder: vi.fn(),
  send: vi.fn(),
  loadURL: vi.fn(),
  stopTracking: vi.fn(),
  trackingFailed: undefined as (() => void) | undefined,
  settingsChanged: undefined as ((state: SettingsWindow) => void) | undefined,
}));
const windows = vi.hoisted(
  () =>
    [] as Array<{
      destroyed: boolean;
      webContents: { mainFrame: object };
      setBounds: ReturnType<typeof vi.fn>;
      hide: ReturnType<typeof vi.fn>;
      showInactive: ReturnType<typeof vi.fn>;
    }>,
);
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class MockWindow extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {},
      startDrag: mocks.startDrag,
      send: mocks.send,
      setWindowOpenHandler: vi.fn(),
    });
    constructor(_options: unknown) {
      super();
      windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
    close() {
      this.destroy();
    }
    loadURL = mocks.loadURL;
    showInactive = vi.fn();
    hide = vi.fn();
    setBounds = vi.fn();
    isVisible = () => false;
    isFocused = () => false;
    show = vi.fn();
    focus = vi.fn();
    getBounds = () => ({ x: 0, y: 0, width: 800, height: 600 });
  }
  return {
    app: {
      getPath: () => "/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code",
    },
    nativeImage: { createFromPath: mocks.createFromPath },
    BrowserWindow: class extends MockWindow {},
    ipcMain: new EventEmitter(),
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }),
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
      getDisplayNearestPoint: () => ({ workArea: { x: -1200, y: 0, width: 1200, height: 900 } }),
    },
    systemPreferences: {
      getMediaAccessStatus: () => (mocks.granted ? "granted" : "denied"),
      isTrustedAccessibilityClient: () => mocks.granted,
    },
    shell: { showItemInFolder: mocks.showItemInFolder },
  };
});
vi.mock("./MacSettingsWindow.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./MacSettingsWindow.ts")>();
  return {
    ...actual,
    watchMacSettingsWindow: (
      onChange: (state: SettingsWindow) => void,
      onUnavailable: () => void,
    ) => {
      mocks.settingsChanged = onChange;
      mocks.trackingFailed = onUnavailable;
      return mocks.stopTracking;
    },
  };
});
let helper: MacPermissionHelper;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.granted = false;
  const icon = { toDataURL: () => "data:image/png;base64,abc" };
  mocks.createFromPath.mockReturnValue({ isEmpty: () => false, resize: () => icon });
  mocks.loadURL.mockResolvedValue(undefined);
  windows.length = 0;
  helper = new MacPermissionHelper();
});
afterEach(() => {
  helper.close();
  vi.useRealTimers();
});
const iconPaths = ["/bundle/prod-resources/icon.png"];
const open = () =>
  helper.show("accessibility", "/bundle/mac-permission-preload.cjs", null, iconPaths);
it("does not reopen a superseded helper when its initial probe completes", async () => {
  const pending = Promise.withResolvers<boolean>();
  const first = helper.show(
    "full-disk-access",
    "/bundle/mac-permission-preload.cjs",
    null,
    iconPaths,
    () => pending.promise,
  );
  await open();
  pending.resolve(false);
  await first;
  expect(windows).toHaveLength(1);
  expect(windows[0]!.destroyed).toBe(false);
});

// S7V-074: the always-on-top helper must be gone once its flow ends.
it("permission helper closes and clears always-on-top once access is granted", async () => {
  await open();
  expect(windows).toHaveLength(1);
  expect(windows[0]!.destroyed).toBe(false);
  mocks.granted = true;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(windows[0]!.destroyed).toBe(true);
});

it("permission helper closes when the user dismisses it", async () => {
  const { ipcMain } = await import("electron");
  await open();
  const window = windows[0]!;
  ipcMain.emit(
    MAC_PERMISSION_HELPER_CHANNEL,
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    "close",
  );
  expect(window.destroyed).toBe(true);
});

it("permission helper is destroyed when its page fails to load", async () => {
  mocks.loadURL.mockRejectedValueOnce(new Error("load failed"));
  await expect(open()).rejects.toThrow("load failed");
  expect(windows).toHaveLength(1);
  expect(windows[0]!.destroyed).toBe(true);
});
