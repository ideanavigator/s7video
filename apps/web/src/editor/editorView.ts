// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/** What the Editor panel's player shows for the project's edit and media (S7V-029). */
import type { MediaAsset, MediaLibrarySnapshot, MediaVariant } from "@t3tools/contracts";

import { clipPlaybackPlan, editPlaybackPlan, type PlaybackPlan } from "./editPlayback";
import type { PlayerSource, ProjectEditState } from "./editStore";
import type { MediaLibraryState } from "../state/media";

export type PlayerView =
  | { readonly _tag: "loading" }
  | { readonly _tag: "unavailable"; readonly message: string }
  /** No clip in the project yet. */
  | { readonly _tag: "empty" }
  /** The edit has a video track, and every part of it was cut. */
  | { readonly _tag: "all-cut" }
  | { readonly _tag: "missing"; readonly asset: MediaAsset }
  | {
      readonly _tag: "play";
      readonly plan: PlaybackPlan;
      readonly asset: MediaAsset;
      readonly variant: Extract<MediaVariant, "original" | "proxy">;
      /** `edit` plays the cut; `clip` a whole clip, picked in Assets or not on the timeline yet. */
      readonly mode: "edit" | "clip";
    };

const playAsset = (asset: MediaAsset, plan: PlaybackPlan, mode: "edit" | "clip"): PlayerView => {
  if (asset.state === "missing") return { _tag: "missing", asset };
  return {
    _tag: "play",
    plan,
    asset,
    // The proxy seeks fast enough to skip cuts cleanly; the original is used until it is ready.
    variant: asset.proxy.status === "ready" ? "proxy" : "original",
    mode,
  };
};

const wholeClip = (asset: MediaAsset, snapshot: MediaLibrarySnapshot): PlayerView | null => {
  if (asset.durationFrames === undefined || asset.durationFrames === 0) return null;
  return playAsset(
    asset,
    clipPlaybackPlan(asset.id, asset.durationFrames, asset.fps ?? snapshot.fps),
    "clip",
  );
};

export function playerViewOf(
  edit: ProjectEditState,
  library: MediaLibraryState,
  source: PlayerSource,
): PlayerView {
  if (edit._tag === "unavailable") return { _tag: "unavailable", message: edit.message };
  if (library._tag === "unavailable") {
    return { _tag: "unavailable", message: "The project's media can't be read right now." };
  }
  if (edit._tag === "loading" || library._tag === "loading") return { _tag: "loading" };
  const { snapshot } = library;
  const assetOf = (mediaId: string) => snapshot.items.find((item) => item.id === mediaId);

  if (source.kind === "clip") {
    const asset = assetOf(source.mediaId);
    const view = asset === undefined ? null : wholeClip(asset, snapshot);
    if (view !== null) return view;
  }

  const document = edit.snapshot.document;
  const plan = editPlaybackPlan(document);
  if (plan !== null) {
    const asset = assetOf(plan.mediaId);
    if (asset !== undefined) return playAsset(asset, plan, "edit");
  }
  if (document.tracks.some((track) => track.kind === "video")) return { _tag: "all-cut" };
  const firstVideo = snapshot.items.find((item) => item.hasVideo);
  const view = firstVideo === undefined ? null : wholeClip(firstVideo, snapshot);
  return view ?? { _tag: "empty" };
}
