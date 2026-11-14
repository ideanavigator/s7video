// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Captions styled in the user's words (S7V-099): the agent's `custom` checked field by field with a
 * plain reason, merged into the track's own, and said back in words. Anything else (a font, an
 * animation, another app's style) is refused by naming what can change; nothing is made up.
 */
import {
  CAPTION_SIZE_RANGE,
  type CaptionPosition,
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

/** "text colour #FF8800, at the top, size 1.4", or "" for none. */
export const describeCaptionCustom = (custom: EditCaptionCustom | undefined) =>
  [
    custom?.textColor === undefined ? null : `text colour ${custom.textColor}`,
    custom?.highlightColor === undefined ? null : `lit word colour ${custom.highlightColor}`,
    custom?.boxColor === undefined ? null : `box colour ${custom.boxColor}`,
    custom?.position === undefined
      ? null
      : custom.position === "middle"
        ? "in the middle"
        : `at the ${custom.position}`,
    custom?.size === undefined ? null : `size ${custom.size}`,
  ]
    .filter((part) => part !== null)
    .join(", ");
