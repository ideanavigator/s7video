// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Clip parts put on the video track in order, as one change and one undo step: the assistant's
 * `video_assemble` (S7V-039) and, later, the Editor's "Add to timeline" (S7V-094) with origin
 * `timeline`. A new project's edit has no tracks; the first add makes V1 and gives the edit the
 * clip's shape in the same step (S7V-093).
 */
import {
  type EditDocument,
  type EditMedia,
  type EditOp,
  type EditOrigin,
  type EditSnapshot,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as EditDocumentService from "./EditDocumentService.ts";
import { firstClipCanvasOps, videoTrackFor } from "./videoTrack.ts";

/** A part of a clip: `in` and `duration` in edit frames. */
export interface ClipPart {
  readonly mediaId: string;
  readonly in: number;
  readonly duration: number;
}

export interface AddClipsInput {
  readonly parts: ReadonlyArray<ClipPart>;
  /** Where a video item starts; the end of the video track when missing. */
  readonly at?: number | undefined;
}

export interface AddClipsResult {
  readonly snapshot: EditSnapshot;
  readonly itemIds: ReadonlyArray<string>;
}

/** Parts that can't be placed, with the plain next step. */
export class ClipPlacementError extends Schema.TaggedError<ClipPlacementError>()(
  "ClipPlacementError",
  {
    reason: Schema.Literals(["no-parts", "bad-part", "unknown-media", "bad-at"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class ClipPlacementService extends Context.Service<
  ClipPlacementService,
  {
    readonly addClips: (
      projectId: ProjectId,
      input: AddClipsInput,
      options: EditDocumentService.EditCaller & { readonly origin: EditOrigin },
    ) => Effect.Effect<AddClipsResult, ClipPlacementError | EditDocumentService.EditApplyError>;
  }
>()("t3/edit/ClipPlacementService") {}

const refuse = (reason: ClipPlacementError["reason"], detail: string) =>
  new ClipPlacementError({ reason, detail });

/**
 * The ops adding `parts` at `at`, and the new items' ids. Mid-edit inserts go only where a video
 * item starts; everything from there on, on every track, moves right by the inserted length
 * (S7V-034): one moveItem per item, or per link group, since moveItem carries linked items.
 */
export function addClipsOps(document: EditDocument, revision: number, input: AddClipsInput) {
  const { parts, at } = input;
  if (parts.length === 0) return refuse("no-parts", "Give at least one clip part to assemble.");
  const track = videoTrackFor(document);
  const placed: EditMedia[] = [];
  for (const part of parts) {
    if (part.in < 0 || part.duration < 1) {
      return refuse("bad-part", "Each part needs in >= 0 and duration >= 1, in edit frames.");
    }
    const media = document.media.find(
      (entry) => entry.id === part.mediaId || entry.path === part.mediaId,
    );
    if (media === undefined) {
      return refuse(
        "unknown-media",
        `${part.mediaId} is not in this edit's media. Import it first.`,
      );
    }
    placed.push(media);
  }
  const end = track.items.reduce((last, item) => Math.max(last, item.start + item.duration), 0);
  const taken = new Set(document.tracks.flatMap((entry) => entry.items.map((item) => item.id)));
  const itemIds: string[] = [];
  for (let index = 0; itemIds.length < parts.length; index++) {
    const id = `asm${revision}-${index}`;
    if (!taken.has(id)) itemIds.push(id);
  }
  const from = at ?? end;
  const length = parts.reduce((total, part) => total + part.duration, 0);
  const shifts: EditOp[] = [];
  if (from !== end) {
    if (!track.items.some((item) => item.start === from)) {
      return refuse(
        "bad-at",
        `at must be where a video item starts, or the end of the edit (frame ${end}).`,
      );
    }
    const groups = new Map<string, Array<{ id: string; start: number; end: number }>>();
    const kindOf = new Map<string, string>();
    for (const entry of document.tracks) {
      for (const item of entry.items) {
        const linkId = "linkId" in item ? item.linkId : undefined;
        const key = linkId === undefined ? `item:${item.id}` : `link:${linkId}`;
        const group = groups.get(key) ?? [];
        group.push({ id: item.id, start: item.start, end: item.start + item.duration });
        groups.set(key, group);
        kindOf.set(item.id, entry.kind);
      }
    }
    for (const group of groups.values()) {
      const first = group.reduce((low, member) => (member.start < low.start ? member : low));
      if (first.start >= from) {
        shifts.push({ _tag: "moveItem", itemId: first.id, start: first.start + length });
        continue;
      }
      // A music bed plays on under the new clips; anything else cut by `at` would drift.
      const across = group.find((member) => member.end > from && kindOf.get(member.id) !== "music");
      if (across !== undefined) {
        return refuse(
          "bad-at",
          `"${across.id}" runs across frame ${from}, so clips can't be added there. Pick a frame where it has ended, or the end (frame ${end}).`,
        );
      }
    }
    if (document.markers.some((marker) => marker.start >= from)) {
      shifts.push({
        _tag: "setMarkers",
        markers: document.markers.map((marker) =>
          marker.start >= from ? { ...marker, start: marker.start + length } : marker,
        ),
      });
    }
  }
  let position = from;
  const inserts = parts.map((part, index): EditOp => {
    const item = {
      id: itemIds[index]!,
      media: placed[index]!.id,
      start: position,
      duration: part.duration,
      in: part.in,
    };
    position += part.duration;
    return { _tag: "insertItem", trackId: track.trackId, item };
  });
  // As the first silence cut does, the first clip on an empty timeline gives the edit its shape.
  const reshape = firstClipCanvasOps(document, placed[0]!);
  return { ops: [...track.addTrack, ...reshape, ...shifts, ...inserts], itemIds };
}

const make = Effect.gen(function* () {
  const edits = yield* EditDocumentService.EditDocumentService;

  const addClips: ClipPlacementService["Service"]["addClips"] = Effect.fn(
    "ClipPlacementService.addClips",
  )(function* (projectId, input, options) {
    const { revision, document } = yield* edits.read(projectId);
    const planned = addClipsOps(document, revision, input);
    if (planned instanceof ClipPlacementError) return yield* planned;
    const count = input.parts.length;
    const snapshot = yield* edits.apply(projectId, planned.ops, {
      origin: options.origin,
      baseRevision: revision,
      reply: options.reply,
      summary: `Added ${count} clip part${count === 1 ? "" : "s"} to the timeline`,
    });
    return { snapshot, itemIds: planned.itemIds };
  });

  return ClipPlacementService.of({ addClips });
});

export const layer = Layer.effect(ClipPlacementService, make);
