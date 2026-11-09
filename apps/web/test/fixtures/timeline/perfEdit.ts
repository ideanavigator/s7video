// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The generated perf edit for the timeline tests (S7V-033, spike B1's `data.ts` on `edit.json` v1):
 * a 3-minute, 30 fps edit with `clips` items over five tracks, from a seeded PRNG so runs compare.
 * No media is needed; the one video media is a placeholder the timeline never decodes.
 */
import type { EditDocument, EditTrack } from "@t3tools/contracts";

function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SHARES = [
  ["video", 0.2, true],
  ["caption", 0.55, true],
  ["sfx", 0.12, false],
  ["music", 0.01, true],
  ["overlay", 0.12, false],
] as const;

export function makePerfEdit(clips = 1_000, durationFrames = 180 * 30): EditDocument {
  const random = mulberry32(42);
  const tracks = SHARES.map(([kind, share, contiguous]): EditTrack => {
    const count = Math.max(kind === "music" ? 3 : 1, Math.round(clips * share));
    const slot = durationFrames / count;
    const items: Array<{ start: number; duration: number; index: number }> = [];
    let cursor = 0;
    for (let index = 0; index < count; index++) {
      if (contiguous) {
        const end =
          index === count - 1
            ? durationFrames
            : Math.round((index + 1) * slot + (random() - 0.5) * slot * 0.4);
        items.push({
          start: cursor,
          duration: Math.max(1, end - cursor - (kind === "caption" ? 2 : 0)),
          index,
        });
        cursor = end;
      } else {
        const duration = Math.max(3, Math.round(slot * (0.2 + random() * 0.5)));
        items.push({
          start: Math.round(index * slot + random() * (slot - duration)),
          duration,
          index,
        });
      }
    }
    const id = (index: number) => `${kind}-${index}`;
    switch (kind) {
      case "video":
        return {
          kind,
          id: "V1",
          items: items.map((item) => ({
            id: id(item.index),
            media: "synth",
            start: item.start,
            duration: item.duration,
            in: item.start,
          })),
        };
      case "caption":
        return {
          kind,
          id: "C1",
          items: items.map((item) => ({
            id: id(item.index),
            start: item.start,
            duration: item.duration,
            text: `word ${item.index}`,
          })),
        };
      case "overlay":
        return {
          kind,
          id: "O1",
          items: items.map((item) => ({
            id: id(item.index),
            start: item.start,
            duration: item.duration,
            text: `Overlay ${item.index + 1}`,
          })),
        };
      default:
        return {
          kind,
          id: kind === "sfx" ? "S1" : "M1",
          items: items.map((item) => ({
            id: id(item.index),
            media: "synth",
            start: item.start,
            duration: item.duration,
            in: 0,
            label: `${kind === "sfx" ? "SFX" : "Music"} ${item.index + 1}`,
          })),
        };
    }
  });
  return {
    version: 1,
    fps: { num: 30, den: 1 },
    canvas: { width: 1920, height: 1080 },
    media: [
      {
        id: "synth",
        kind: "video",
        reference: "/synthetic/testsrc2.mp4",
        fingerprint: { sha256: "0".repeat(64), size: 1 },
        probe: { durationFrames, hasVideo: true, hasAudio: true },
        label: "testsrc2.mp4",
      },
    ],
    tracks,
    markers: [],
    metadata: {},
  };
}

export const itemCountOf = (document: EditDocument): number =>
  document.tracks.reduce((total, track) => total + track.items.length, 0);
