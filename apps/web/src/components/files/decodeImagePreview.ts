import {
  canConvertHeic,
  convertHeicOnDesktop,
  HEIC_CONVERT_FIRST_MESSAGE,
} from "~/lib/desktopHeic";
import { validateHeif } from "./imagePreviewLimits";
import { readBinaryPreview } from "./readBinaryPreview";

// Workers cannot reach the desktop bridge, so HEIF decodes on this thread through IPC.
async function decodeHeifPreview(src: string, signal: AbortSignal) {
  if (!canConvertHeic()) throw new Error(HEIC_CONVERT_FIRST_MESSAGE);
  const bytes = await readBinaryPreview(src, signal);
  validateHeif(bytes);
  const result = await convertHeicOnDesktop(new Uint8Array(bytes), "image/png");
  if (signal.aborted) throw new Error("Image decoding cancelled.");
  if (!result.ok) throw new Error("Could not decode this image.");
  return result.blob;
}

export async function decodeImagePreview(src: string, heif: boolean, signal: AbortSignal) {
  if (heif) return decodeHeifPreview(src, signal);
  const worker = new Worker(new URL("./imageDecode.worker.ts", import.meta.url), {
    type: "module",
  });
  const controller = new AbortController();
  try {
    return await new Promise<Blob>((resolve, reject) => {
      const fail = (message: string) => reject(new Error(message));
      const abort = () => fail("Image decoding cancelled.");
      signal.addEventListener("abort", abort, { signal: controller.signal });
      if (signal.aborted) return abort();
      const timer = setTimeout(() => fail("This image took too long to decode."), 30_000);
      controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      worker.addEventListener("error", () => fail("Could not load the image decoder."));
      worker.addEventListener("message", (event: MessageEvent<{ blob?: Blob; error?: string }>) => {
        if (event.data.blob) resolve(event.data.blob);
        else fail(event.data.error ?? "Could not decode this image.");
      });
      void readBinaryPreview(src, controller.signal).then(
        (bytes) => worker.postMessage({ bytes }, [bytes]),
        reject,
      );
    });
  } finally {
    controller.abort();
    worker.terminate();
  }
}
