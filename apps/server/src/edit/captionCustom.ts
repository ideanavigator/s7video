// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Captions styled in the user's words (S7V-099): the agent's `custom` checked field by field with a
 * plain reason, merged into the track's own, and said back in words. Anything else (a font, an
 * animation, another app's style) is refused by naming what can change; nothing is made up.
 */
import {
  CAPTION_LOOK_PARTS,
  CAPTION_PRESET_NAMES,
  CAPTION_SIZE_RANGE,
  type CaptionPosition,
  type CaptionPresetId,
  type EditCaptionCustom,
} from "@t3tools/contracts";

const COLOR_FIELDS = ["textColor", "highlightColor", "boxColor"] as const;
const FIELDS = new Set<string>([...COLOR_FIELDS, "size", "position"]);
const POSITIONS: ReadonlyArray<CaptionPosition> = ["top", "middle", "bottom"];
const HEX = /^#?([0-9a-f]{6})$/iu;

const CUSTOM_FIELDS_HELP =
  "Captions can change textColor, highlightColor (the lit word in Highlighted word), boxColor (the box in Boxed), size (0.6 to 1.6, 1 is the look's own) and position (top, middle or bottom).";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The agent's `custom` as stored (colours `#RRGGBB`), or the plain reason it can't be used. */
export const parseCaptionCustom = (
  input: unknown,
): { readonly custom: EditCaptionCustom } | { readonly error: string } => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { error: `custom is an object such as {"textColor": "#FF8800"}. ${CUSTOM_FIELDS_HELP}` };
  }
  const entries = Object.entries(input);
  const unknown = entries.map(([key]) => key).filter((key) => !FIELDS.has(key));
  if (unknown.length > 0) {
    return {
      error: `${unknown.join(", ")} can't be changed. ${CUSTOM_FIELDS_HELP} Tell the user plainly what can change; never make up another style.`,
    };
  }
  const custom: Mutable<EditCaptionCustom> = {};
  for (const [key, value] of entries) {
    if (key === "size") {
      if (
        typeof value !== "number" ||
        !(value >= CAPTION_SIZE_RANGE.minimum && value <= CAPTION_SIZE_RANGE.maximum)
      ) {
        return { error: "size is a number from 0.6 to 1.6; 1 is the look's own size." };
      }
      custom.size = Math.round(value * 100) / 100;
    } else if (key === "position") {
      const position = POSITIONS.find((entry) => entry === value);
      if (position === undefined) return { error: "position is top, middle or bottom." };
      custom.position = position;
    } else {
      const hex = typeof value === "string" ? HEX.exec(value.trim()) : null;
      if (hex === null) return { error: `${key} is a hex colour such as #FF8800.` };
      custom[key as (typeof COLOR_FIELDS)[number]] = `#${hex[1]!.toUpperCase()}`;
    }
  }
  return { custom };
};

/** The track's own colours, size and place with the new ones on top; the look's own size is none. */
export const mergeCaptionCustom = (
  current: EditCaptionCustom | undefined,
  changes: EditCaptionCustom,
): EditCaptionCustom => {
  const merged: Mutable<EditCaptionCustom> = { ...current, ...changes };
  if (merged.size === 1) delete merged.size;
  if (merged.position === "bottom") delete merged.position;
  return merged;
};

export const sameCaptionCustom = (a: EditCaptionCustom | undefined, b: EditCaptionCustom) => {
  const left = a ?? {};
  const keys = new Set([...Object.keys(left), ...Object.keys(b)]);
  return [...keys].every(
    (key) => left[key as keyof EditCaptionCustom] === b[key as keyof EditCaptionCustom],
  );
};

/** The caption-style skill's colours, by name: what the user said is what they read back. */
const COLOR_NAMES: Readonly<Record<string, string>> = {
  "#FF8800": "orange",
  "#FF3B30": "red",
  "#FFD60A": "yellow",
  "#34C759": "green",
  "#0A84FF": "blue",
  "#FF2D92": "pink",
  "#AF52DE": "purple",
  "#000000": "black",
  "#FFFFFF": "white",
};

const sizeWords = (size: number) =>
  size > 1 ? (size >= 1.3 ? "bigger" : "a bit bigger") : size <= 0.8 ? "smaller" : "a bit smaller";

/**
 * The look's own colours, size and place in editing words, never codes (UX guide rule 5):
 * "orange, blue box, at the top, bigger", or "" for none. Parts the look doesn't draw are left out.
 */
export const describeCaptionCustom = (
  custom: EditCaptionCustom | undefined,
  preset: CaptionPresetId,
) => {
  const parts = CAPTION_LOOK_PARTS[preset];
  const named = (hex: string | undefined, part: string, unnamed: string) =>
    hex === undefined
      ? null
      : COLOR_NAMES[hex] === undefined
        ? unnamed
        : `${COLOR_NAMES[hex]}${part}`;
  return [
    named(custom?.textColor, "", "a custom text colour"),
    parts.includes("highlight")
      ? named(custom?.highlightColor, " lit word", "a custom colour for the lit word")
      : null,
    parts.includes("box") ? named(custom?.boxColor, " box", "a custom box colour") : null,
    custom?.position === undefined
      ? null
      : custom.position === "middle"
        ? "in the middle"
        : `at the ${custom.position}`,
    custom?.size === undefined ? null : sizeWords(custom.size),
  ]
    .filter((part) => part !== null)
    .join(", ");
};

/**
 * A colour for a part the look doesn't draw, as the plain reason (S7V-099): checked on what the
 * user asked for now, so a box colour kept from Boxed never stops a change to another look.
 */
export const missingLookPart = (changes: EditCaptionCustom, preset: CaptionPresetId) => {
  const parts = CAPTION_LOOK_PARTS[preset];
  const name = CAPTION_PRESET_NAMES[preset];
  if (changes.boxColor !== undefined && !parts.includes("box")) {
    return `The ${name} look has no box. Say "boxed" to add one.`;
  }
  if (changes.highlightColor !== undefined && !parts.includes("highlight")) {
    return `The ${name} look doesn't light up the word being said. Say "highlighted word" to use that look.`;
  }
  return null;
};
