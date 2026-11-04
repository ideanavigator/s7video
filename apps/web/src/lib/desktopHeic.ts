import type { DesktopHeicConversionFormat } from "@t3tools/contracts";

export const HEIC_CONVERT_FIRST_MESSAGE =
  "HEIC photos open only in the desktop app. Convert this photo to JPEG first.";

export type DesktopHeicConversion =
  | { ok: true; blob: Blob }
  | { ok: false; reason: "unsupported-heic" | "unreadable" };

const heicBridge = () =>
  typeof window === "undefined" ? undefined : window.desktopBridge?.convertHeic;

/** Browsers cannot decode HEIC; the desktop app does it with macOS ImageIO. */
export function canConvertHeic(): boolean {
  return heicBridge() !== undefined;
}

export async function convertHeicOnDesktop(
  data: Uint8Array,
  format: DesktopHeicConversionFormat,
): Promise<DesktopHeicConversion> {
  const convert = heicBridge();
  if (!convert) return { ok: false, reason: "unsupported-heic" };
  const result = await convert({ data, format }).catch(() => null);
  if (!result?.ok) {
    return {
      ok: false,
      reason: result?.reason === "unsupported" ? "unsupported-heic" : "unreadable",
    };
  }
  return { ok: true, blob: new Blob([result.data as Uint8Array<ArrayBuffer>], { type: format }) };
}
