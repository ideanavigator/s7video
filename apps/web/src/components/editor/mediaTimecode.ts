// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { EditRational } from "@t3tools/contracts";

/** A clip length as `m:ss`, or `h:mm:ss` from one hour up, in whole seconds at the media's rate. */
export function formatMediaLength(frames: number, rate: EditRational): string {
  const seconds = Math.floor((Math.max(0, Math.trunc(frames)) * rate.den) / rate.num);
  const ss = seconds % 60;
  const minutes = Math.floor(seconds / 60);
  const pad = (value: number) => String(value).padStart(2, "0");
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(ss)}`
    : `${minutes}:${pad(ss)}`;
}

/** A spoken length for screen readers: "1 minute 5 seconds". */
export function spokenMediaLength(frames: number, rate: EditRational): string {
  const seconds = Math.floor((Math.max(0, frames) * rate.den) / rate.num);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`;
  if (minutes === 0) return unit(rest, "second");
  return rest === 0
    ? unit(minutes, "minute")
    : `${unit(minutes, "minute")} ${unit(rest, "second")}`;
}
