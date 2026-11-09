// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/** What the Editor panel's player shows for the project's edit and media (S7V-029). */
import type { MediaAsset, MediaLibrarySnapshot, MediaVariant } from "@t3tools/contracts";

import {
  clipPlaybackPlan,
  editPlaybackPlan,
  editTimelinePlan,
  type PlaybackPlan,
  playsAsSingleSource,
  type TimelinePlan,
} from "./editPlayback";
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
    }
  /** The edit from several clips, or with gaps or reordered parts, on the player clock (S7V-039). */
  | {
      readonly _tag: "play-timeline";
      readonly plan: TimelinePlan;
      /** One entry per media id the plan uses, in first-use order. */
      readonly sources: ReadonlyArray<TimelineSourceView>;
    };

export interface TimelineSourceView {
  readonly mediaId: string;
  /** Undefined when the edit names media the library does not have. */
  readonly asset: MediaAsset | undefined;
  /** The library's label, or the file name the edit records; never an internal id. */
  readonly label: string;
  readonly variant: Extract<MediaVariant, "original" | "proxy">;
}

const variantOf = (asset: MediaAsset): Extract<MediaVariant, "original" | "proxy"> =>
  // The proxy seeks fast enough to skip cuts cleanly; the original is used until it is ready.
  asset.proxy.status === "ready" ? "proxy" : "original";

const playAsset = (asset: MediaAsset, plan: PlaybackPlan, mode: "edit" | "clip"): PlayerView => {
  if (asset.state === "missing") return { _tag: "missing", asset };
  return {
    _tag: "play",
    plan,
    asset,
    variant: variantOf(asset),
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

  const document = source.kind === "version" ? source.document : edit.snapshot.document;
  const timeline = editTimelinePlan(document);
  // One source laid end to end keeps Engine A's player; any other layout plays on the clock.
  const plan =
    timeline === null || playsAsSingleSource(timeline) ? editPlaybackPlan(document) : null;
  if (plan !== null) {
    const asset = assetOf(plan.mediaId);
    if (asset !== undefined) return playAsset(asset, plan, "edit");
  }
  // A version's clip may have left Assets since: the clock player shows it as missing.
  if (timeline !== null && (plan === null || source.kind === "version")) {
    return {
      _tag: "play-timeline",
      plan: timeline,
      sources: timeline.mediaIds.map((mediaId) => {
        const asset = assetOf(mediaId);
        const recorded = document.media.find((entry) => entry.id === mediaId);
        const file = (recorded?.path ?? recorded?.reference)?.split(/[\\/]/u).at(-1);
        return {
          mediaId,
          asset,
          label: asset?.label ?? (file || "a clip"),
          variant: asset === undefined ? "original" : variantOf(asset),
        };
      }),
    };
  }
  if (document.tracks.some((track) => track.kind === "video")) return { _tag: "all-cut" };
  const firstVideo = snapshot.items.find((item) => item.hasVideo);
  const view = firstVideo === undefined ? null : wholeClip(firstVideo, snapshot);
  return view ?? { _tag: "empty" };
}
