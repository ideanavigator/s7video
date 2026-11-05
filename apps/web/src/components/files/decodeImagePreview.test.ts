// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { HEIC_CONVERT_FIRST_MESSAGE } from "~/lib/desktopHeic";
import { decodeImagePreview } from "./decodeImagePreview";

const convertHeic = vi.fn();

function box(type: string, ...contents: Uint8Array[]) {
  const bytes = new Uint8Array(8 + contents.reduce((size, content) => size + content.length, 0));
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(new TextEncoder().encode(type), 4);
  let offset = 8;
  for (const content of contents) {
    bytes.set(content, offset);
    offset += content.length;
  }
  return bytes;
}

function heif(width: number, height: number) {
  const size = new Uint8Array(12);
  new DataView(size.buffer).setUint32(4, width);
  new DataView(size.buffer).setUint32(8, height);
  return new Blob([
    box("ftyp", new TextEncoder().encode("heic"), new Uint8Array(4)),
    box("meta", new Uint8Array(4), box("iprp", box("ipco", box("ispe", size)))),
  ]);
}

function serve(body: Blob, headers: Record<string, string> = {}) {
  const fetch = vi.fn(async () => new Response(body, { headers }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const decode = () => decodeImagePreview("blob:photo", true, new AbortController().signal);

afterEach(() => {
  convertHeic.mockReset();
  vi.unstubAllGlobals();
});

describe("HEIF preview", () => {
  it("decodes through the desktop bridge as PNG", async () => {
    vi.stubGlobal("window", { desktopBridge: { convertHeic } });
    const source = heif(4032, 3024);
    serve(source);
    convertHeic.mockResolvedValueOnce({
      ok: true,
      data: new Uint8Array([137, 80, 78, 71]),
      mimeType: "image/png",
    });

    const blob = await decode();

    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(4);
    expect(convertHeic).toHaveBeenCalledWith({
      data: new Uint8Array(await source.arrayBuffer()),
      format: "image/png",
    });
  });

  it("asks for a JPEG without fetching when there is no desktop bridge", async () => {
    const fetch = serve(heif(10, 10));

    await expect(decode()).rejects.toThrow(HEIC_CONVERT_FIRST_MESSAGE);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { name: "over 50 MB", source: heif(10, 10), headers: { "content-length": "52428801" } },
    { name: "over 32 megapixels", source: heif(8000, 6000), headers: {} },
    { name: "without dimensions", source: new Blob(["not a heif"]), headers: {} },
  ])("refuses a photo $name before decoding", async ({ source, headers }) => {
    vi.stubGlobal("window", { desktopBridge: { convertHeic } });
    serve(source, headers);

    await expect(decode()).rejects.toThrow();
    expect(convertHeic).not.toHaveBeenCalled();
  });

  it("reports a corrupt photo the decoder cannot read", async () => {
    vi.stubGlobal("window", { desktopBridge: { convertHeic } });
    serve(heif(10, 10));
    convertHeic.mockResolvedValueOnce({ ok: false, reason: "unreadable" });

    await expect(decode()).rejects.toThrow("Could not decode this image.");
  });
});
