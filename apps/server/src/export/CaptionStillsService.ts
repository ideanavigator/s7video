// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The player's caption stills (S7V-075): the engine's `captions.render` draws each caption chunk
 * with the export's own ASS and libass, so the player shows what the export burns in. Cached in
 * `.s7cache/captions/<key>/` by a hash of everything the stills depend on, so undo, redo and an
 * unrelated change cost no render. Stills travel inline: one round trip, no URL per still.
 */
import {
  CaptionsRenderResult,
  type CaptionStillsResult,
  type EditDocument,
  EditUnavailableError,
  type EngineError,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as EditDocumentService from "../edit/EditDocumentService.ts";
import * as EngineService from "../engine/EngineService.ts";
import * as ProjectService from "../project/ProjectService.ts";

/** Bump when the stills' drawing changes, so old caches are drawn again. */
const STILLS_VERSION = 1;
/** Caches kept per project; older ones are removed after a new render. */
const KEEP_CACHES = 12;
const INDEX_FILE = "index.json";

const IndexJson = Schema.fromJsonString(CaptionsRenderResult);
const decodeIndex = Schema.decodeUnknownOption(IndexJson);
const encodeIndex = Schema.encodeEffect(IndexJson);
const encodeKeyInput = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class CaptionStillsService extends Context.Service<
  CaptionStillsService,
  {
    readonly stills: (
      projectId: ProjectId,
    ) => Effect.Effect<CaptionStillsResult, EditUnavailableError | EngineError>;
  }
>()("t3/export/CaptionStillsService") {}

/** What the stills depend on: the canvas, the rate, where the video ends and the caption tracks. */
const stillsInput = (document: EditDocument) => {
  const video = document.tracks.find((track) => track.kind === "video");
  return {
    version: STILLS_VERSION,
    fps: document.fps,
    canvas: document.canvas,
    end: Math.max(0, ...(video?.items ?? []).map((item) => item.start + item.duration)),
    captions: document.tracks.filter((track) => track.kind === "caption"),
  };
};

const hasCaptions = (document: EditDocument) =>
  document.tracks.some(
    (track) => track.kind === "caption" && track.muted !== true && track.items.length > 0,
  );

const make = Effect.gen(function* () {
  const edits = yield* EditDocumentService.EditDocumentService;
  const projects = yield* ProjectService.ProjectService;
  const engine = yield* EngineService.EngineService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  // One render at a time: the player asks again after each change, and a render takes ~0.2 s.
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

  const readCache = Effect.fnUntraced(function* (folder: string) {
    const text = yield* fileSystem
      .readFileString(path.join(folder, INDEX_FILE))
      .pipe(Effect.option);
    if (Option.isNone(text)) return Option.none();
    const index = decodeIndex(text.value);
    if (Option.isNone(index)) return Option.none();
    const names = [...new Set(index.value.chunks.map((chunk) => chunk.png))];
    const files = yield* Effect.forEach(names, (name) =>
      fileSystem.readFile(path.join(folder, path.basename(name))),
    ).pipe(Effect.option);
    if (Option.isNone(files)) return Option.none();
    return Option.some({ index: index.value, names, files: files.value });
  });

  /** Removes all but the newest caches; a failure only leaves more files behind. */
  const prune = Effect.fnUntraced(function* (cacheDir: string) {
    const entries = yield* fileSystem.readDirectory(cacheDir);
    const dated = yield* Effect.forEach(entries, (name) =>
      fileSystem.stat(path.join(cacheDir, name)).pipe(
        Effect.map((info) => ({
          name,
          at: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
        })),
      ),
    );
    const old = dated.toSorted((a, b) => b.at - a.at).slice(KEEP_CACHES);
    yield* Effect.forEach(old, ({ name }) =>
      fileSystem.remove(path.join(cacheDir, name), { recursive: true }),
    );
  });

  const render = Effect.fnUntraced(function* (
    document: EditDocument,
    cacheDir: string,
    folder: string,
  ) {
    const temp = path.join(cacheDir, `.tmp-${yield* crypto.randomUUIDv4()}`);
    const result = yield* engine.call(
      "captions.render",
      { edit: document, outDir: temp },
      CaptionsRenderResult,
    );
    const write = Effect.gen(function* () {
      yield* fileSystem.writeFileString(path.join(temp, INDEX_FILE), yield* encodeIndex(result));
      yield* fileSystem.rename(temp, folder);
    });
    // Another render of the same key may have landed first; its files are the same.
    yield* write.pipe(
      Effect.catch(() => fileSystem.remove(temp, { recursive: true }).pipe(Effect.ignore)),
    );
    yield* prune(cacheDir).pipe(Effect.ignore);
  });

  const stills: CaptionStillsService["Service"]["stills"] = Effect.fn(
    "CaptionStillsService.stills",
  )(function* (projectId) {
    const snapshot = yield* edits.read(projectId);
    const { document } = snapshot;
    const { width, height } = document.canvas;
    if (!hasCaptions(document)) return { key: "none", width, height, chunks: [], stills: [] };
    const keyInput = yield* encodeKeyInput(stillsInput(document)).pipe(Effect.orDie);
    const bytes = new TextEncoder().encode(keyInput);
    const key = yield* crypto.digest("SHA-256", bytes).pipe(Effect.map(Hex.encode), Effect.orDie);
    const cacheDir = path.join(yield* rootOf(projectId), ".s7cache", "captions");
    const folder = path.join(cacheDir, key);
    let cached = yield* readCache(folder);
    if (Option.isNone(cached)) {
      cached = yield* rendering.withPermit(
        Effect.gen(function* () {
          const again = yield* readCache(folder);
          if (Option.isSome(again)) return again;
          yield* fileSystem.makeDirectory(cacheDir, { recursive: true }).pipe(Effect.orDie);
          yield* render(document, cacheDir, folder).pipe(
            Effect.catchTags({
              PlatformError: () =>
                Effect.fail(
                  new EditUnavailableError({
                    projectId,
                    reason: "write-failed",
                    explanation: "Could not save the caption pictures for the player.",
                  }),
                ),
            }),
          );
          return yield* readCache(folder);
        }),
      );
    }
    if (Option.isNone(cached)) return yield* Effect.die("caption stills were not written");
    const { index, names, files } = cached.value;
    const at = new Map(names.map((name, number) => [name, number]));
    return {
      key,
      width: index.width,
      height: index.height,
      chunks: index.chunks.map((chunk) => ({
        start: chunk.start,
        end: chunk.end,
        still: at.get(chunk.png)!,
      })),
      stills: files.map((file) => Base64.encode(file)),
    };
  });

  return CaptionStillsService.of({ stills });
});

export const layer = Layer.effect(CaptionStillsService, make);
