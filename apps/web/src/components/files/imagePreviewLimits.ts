// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
const MAX_PIXELS = 32_000_000;

export function assertPreviewDimensions(width: number, height: number) {
  if (!(width > 0 && height > 0) || width > 16384 || height > 16384 || width > MAX_PIXELS / height)
    throw new Error("Image previews are limited to 32 megapixels and 16,384 pixels per side.");
}

export function validateHeif(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  let found = false;
  let count = 0;
  const boxes = (start: number, end: number, depth: number) => {
    if (depth > 4) return;
    let offset = start;
    while (offset + 8 <= end) {
      if (++count > 2048) throw new Error("This image has too much metadata.");
      let size = view.getUint32(offset);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) throw new Error("Invalid HEIF metadata.");
        const large = view.getBigUint64(offset + 8);
        if (large > BigInt(bytes.byteLength)) throw new Error("Invalid HEIF metadata.");
        size = Number(large);
        header = 16;
      } else if (size === 0) size = end - offset;
      if (size < header || offset + size > end) throw new Error("Invalid HEIF metadata.");
      const type = view.getUint32(offset + 4);
      if (type === 0x69737065) {
        if (size < header + 12) throw new Error("Invalid HEIF dimensions.");
        assertPreviewDimensions(
          view.getUint32(offset + header + 4),
          view.getUint32(offset + header + 8),
        );
        found = true;
      } else if (type === 0x6d657461 || type === 0x69707270 || type === 0x6970636f)
        boxes(offset + header + (type === 0x6d657461 ? 4 : 0), offset + size, depth + 1);
      offset += size;
    }
  };
  boxes(0, bytes.byteLength, 0);
  if (!found) throw new Error("This HEIF image has no readable dimensions.");
}
