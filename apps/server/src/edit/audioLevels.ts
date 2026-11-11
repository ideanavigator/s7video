// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Our level presets for sound effects and music (S7V-036, PO 2026-11-08), in dB relative to the
 * voice's integrated loudness. They are starting points the agent may change per item, not taken
 * from any client project. The export then brings the whole mix to −14 LUFS with one gain.
 */
export const SFX_LEVEL_DB = { subtle: -14, normal: -9, hit: -6 } as const;
export const MUSIC_BED_DB = -18;
export const DUCK_DEPTH_DB = -12;
/** The reference when the voice clip is silent: the export's target, so levels stay sensible. */
export const SILENT_VOICE_LUFS = -14;

export const defaultLevelDb = (track: "sfx" | "music") =>
  track === "sfx" ? SFX_LEVEL_DB.normal : MUSIC_BED_DB;

/**
 * The item's `gainDb`, which is relative to its own file, that plays it `levelDb` from the voice:
 * voice −20 LUFS, file −10 LUFS, "normal" −9 dB gives −19 dB. Rounded to 0.1 dB.
 */
export const itemGainDb = (voiceLufs: number, assetLufs: number, levelDb: number) =>
  Math.round((voiceLufs + levelDb - assetLufs) * 10) / 10;
