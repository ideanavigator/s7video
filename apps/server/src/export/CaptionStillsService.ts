// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The player's caption stills (S7V-075): what the export burns in (caption items, or the
 * transcripts), drawn by the engine with the export's ASS and libass, cached per text in
 * `.s7cache/captions/`. Inline base64: about 13 MB for a 10-minute talk (`captions.md`).
 */
import {
  CaptionsRenderResult,
  type CaptionStillsResult,
  type EditDocument,
  EditUnavailableError,
  type EngineError,
  type ProjectId,
} from "@t3tools/contracts";
import { transcriptCaptionTrackOf } from "@t3tools/shared/captionWords";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { loadCaptionTranscripts } from "../edit/captionTrack.ts";
import * as EditDocumentService from "../edit/EditDocumentService.ts";
import * as EngineService from "../engine/EngineService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { transcriptMediaFor } from "./ExportService.ts";

const encodeKeyInput = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** The quick-call limit, plus room for drawing each word's still on an 8 GB M1 Air. */
const BASE_TIMEOUT_MS = 30_000;
const TIMEOUT_MS_PER_WORD = 100;

export class CaptionStillsService extends Context.Service<
  CaptionStillsService,
  {
    readonly stills: (
      projectId: ProjectId,
    ) => Effect.Effect<CaptionStillsResult, EditUnavailableError | EngineError>;
  }
>()("t3/export/CaptionStillsService") {}

const wordCount = (document: EditDocument, transcripts: ReadonlyArray<{ words: unknown[] }>) =>
  document.tracks
    .flatMap((track) => (track.kind === "caption" ? track.items : []))
    .reduce((sum, item) => sum + (item.words?.length ?? item.text.split(" ").length), 0) +
  transcripts.reduce((sum, transcript) => sum + transcript.words.length, 0);

const make = Effect.gen(function* () {
  const edits = yield* EditDocumentService.EditDocumentService;
  const projects = yield* ProjectService.ProjectService;
  const engine = yield* EngineService.EngineService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  // One render at a time: the player asks again after each change.
  const rendering = yield* Semaphore.make(1);

  const rootOf = Effect.fnUntraced(function* (projectId: ProjectId) {
    const project = yield* projects.getById(projectId).pipe(Effect.orElseSucceed(Option.none));
    if (Option.isNone(project)) {
      return yield* new EditUnavailableError({
        projectId,
        reason: "unknown-project",
        explanation: "This project no longer exists.",
      });
    }
    return path.resolve(project.value.workspaceRoot);
  });

  const unreadable = (projectId: ProjectId) =>
    new EditUnavailableError({
      projectId,
      reason: "unreadable",
      explanation: "Could not read the caption pictures for the player.",
    });

  const stills: CaptionStillsService["Service"]["stills"] = Effect.fn(
    "CaptionStillsService.stills",
  )(function* (projectId) {
    const { document } = yield* edits.read(projectId);
    const root = yield* rootOf(projectId);
    const loaded = yield* loadCaptionTranscripts(root, document).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    // The export's rule: transcripts caption the edit only while no caption track has items.
    const fallbackMedia = new Set(transcriptMediaFor(document, true));
    const transcripts = [...loaded.transcripts]
      .filter(([media]) => fallbackMedia.has(media))
      .map(([media, transcript]) => ({ media, fps: transcript.fps, words: [...transcript.words] }));
    const labelOf = (id: string) => {
      const media = document.media.find((entry) => entry.id === id);
      return media?.label ?? path.basename(media?.path ?? media?.reference ?? id);
    };
    // Clips whose captions can't follow the edit: under the transcript track, or in the fallback.
    const missing =
      transcriptCaptionTrackOf(document) !== undefined || fallbackMedia.size > 0
        ? loaded.missing.map(labelOf)
        : [];
    const drawable =
      transcripts.length > 0 ||
      document.tracks.some(
        (track) => track.kind === "caption" && track.muted !== true && track.items.length > 0,
      );
    const { width, height } = document.canvas;
    if (!drawable) return { key: "none", width, height, chunks: [], stills: [], missing };
    const cacheDir = path.join(root, ".s7cache", "captions");
    const timeout = Duration.millis(
      BASE_TIMEOUT_MS + TIMEOUT_MS_PER_WORD * wordCount(document, transcripts),
    );
    const rendered = yield* rendering.withPermit(
      engine.call(
        "captions.render",
        { edit: document, cacheDir, ...(transcripts.length > 0 ? { transcripts } : {}) },
        CaptionsRenderResult,
        timeout,
      ),
    );
    const names = [...new Set(rendered.chunks.map((chunk) => chunk.png))];
    const folder = path.join(cacheDir, path.basename(rendered.folder));
    const files = yield* Effect.forEach(names, (name) =>
      fileSystem.readFile(path.join(folder, path.basename(name))),
    ).pipe(Effect.mapError(() => unreadable(projectId)));
    const at = new Map(names.map((name, number) => [name, number]));
    const chunks = rendered.chunks.map((chunk) => ({
      start: chunk.start,
      end: chunk.end,
      still: at.get(chunk.png)!,
    }));
    // The look folder and the chunks name everything the player shows.
    const keyText = yield* encodeKeyInput([rendered.folder, rendered.chunks]).pipe(Effect.orDie);
    const keyBytes = new TextEncoder().encode(keyText);
    const key = yield* crypto
      .digest("SHA-256", keyBytes)
      .pipe(Effect.map(Hex.encode), Effect.orDie);
    return {
      key: chunks.length === 0 ? "none" : key,
      width: rendered.width,
      height: rendered.height,
      chunks,
      stills: files.map((file) => Base64.encode(file)),
      missing,
    };
  });

  return CaptionStillsService.of({ stills });
});

export const layer = Layer.effect(CaptionStillsService, make);
