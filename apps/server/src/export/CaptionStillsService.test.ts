// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- The fake engine writes the stills it is asked for.
/**
 * S7V-075: the player's caption stills come from the engine once per look and timing of the
 * captions, and are served from `.s7cache/captions/` after that: undo back to the same captions
 * draws nothing again. The engine is faked; `test_captions.py` covers the real drawing.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { EditOp, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as EditDocumentService from "../edit/EditDocumentService.ts";
import { layerEditTest } from "../edit/editHarness.testkit.ts";
import * as EngineService from "../engine/EngineService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as CaptionStillsService from "./CaptionStillsService.ts";

interface EngineCall {
  readonly method: string;
  readonly outDir: string;
}

/** Answers `captions.render` with one still per caption text, as the engine does. */
const fakeEngine = (calls: Array<EngineCall>) =>
  Layer.mock(EngineService.EngineService)({
    call: (method, params, success) =>
      Effect.gen(function* () {
        const { edit, outDir } = params as {
          edit: { tracks: ReadonlyArray<{ kind: string; items: ReadonlyArray<never> }> };
          outDir: string;
        };
        calls.push({ method, outDir });
        NodeFS.mkdirSync(outDir, { recursive: true });
        const items = edit.tracks
          .filter((track) => track.kind === "caption")
          .flatMap((track) => track.items) as ReadonlyArray<{
          start: number;
          duration: number;
          text: string;
        }>;
        const texts = [...new Set(items.map((item) => item.text))];
        texts.forEach((text, index) =>
          NodeFS.writeFileSync(NodePath.join(outDir, `still-${index}.png`), `png:${text}`),
        );
        return yield* Schema.decodeEffect(success)({
          width: 1080,
          height: 1920,
          chunks: items.map((item) => ({
            start: item.start,
            end: item.start + item.duration,
            png: `still-${texts.indexOf(item.text)}.png`,
          })),
        }).pipe(Effect.orDie);
      }),
  });

const media = {
  id: "cam",
  kind: "video",
  path: "assets/cam.mp4",
  fingerprint: { sha256: "ab".repeat(32), size: 4096 },
  probe: { durationFrames: 900, hasVideo: true, hasAudio: true },
} as const;

const setup: ReadonlyArray<EditOp> = [
  { _tag: "putMedia", media },
  {
    _tag: "addTrack",
    track: {
      kind: "video",
      id: "V1",
      items: [{ id: "v1", media: "cam", start: 0, duration: 90, in: 0 }],
    },
  },
  { _tag: "addTrack", track: { kind: "caption", id: "C1", items: [] } },
];

const captions = (texts: ReadonlyArray<string>): EditOp => ({
  _tag: "setCaptions",
  trackId: "C1",
  captions: texts.map((text, index) => ({ start: index * 20, duration: 15, text })),
});

const withStills = <A, E>(
  body: (input: {
    readonly projectId: ProjectId;
    readonly root: string;
    readonly calls: Array<EngineCall>;
    readonly edits: EditDocumentService.EditDocumentService["Service"];
    readonly stills: CaptionStillsService.CaptionStillsService["Service"];
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-stills-" });
    const calls: Array<EngineCall> = [];
    return yield* Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const created = yield* folders.createNamedProject({ name: "Stills test" });
      return yield* body({
        projectId: created.projectId,
        root: created.workspaceRoot,
        calls,
        edits: yield* EditDocumentService.EditDocumentService,
        stills: yield* CaptionStillsService.CaptionStillsService,
      });
    }).pipe(
      Effect.provide(
        CaptionStillsService.layer.pipe(
          Layer.provide(fakeEngine(calls)),
          Layer.provideMerge(layerEditTest(baseDir)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const apply = (
  edits: EditDocumentService.EditDocumentService["Service"],
  projectId: ProjectId,
  ops: ReadonlyArray<EditOp>,
) =>
  edits
    .read(projectId)
    .pipe(
      Effect.flatMap((snapshot) =>
        edits.apply(projectId, ops, { origin: "agent", baseRevision: snapshot.revision }),
      ),
    );

describe("CaptionStillsService (S7V-075)", () => {
  it.effect("draws once per caption look, and serves undo from the cache", () =>
    withStills(({ projectId, root, calls, edits, stills }) =>
      Effect.gen(function* () {
        yield* apply(edits, projectId, [
          ...setup,
          captions(["hello there", "again", "hello there"]),
        ]);
        const first = yield* stills.stills(projectId);
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(first.chunks, [
          { start: 0, end: 15, still: 0 },
          { start: 20, end: 35, still: 1 },
          { start: 40, end: 55, still: 0 },
        ]);
        assert.deepStrictEqual(
          first.stills.map((still) => Buffer.from(still, "base64").toString()),
          ["png:hello there", "png:again"],
        );
        assert.isTrue(
          NodeFS.existsSync(NodePath.join(root, ".s7cache", "captions", first.key, "index.json")),
        );
        // A change that leaves the captions alone draws nothing.
        yield* apply(edits, projectId, [
          { _tag: "setMarkers", markers: [{ id: "mk", start: 5, duration: 0, label: "Hook" }] },
        ]);
        assert.strictEqual((yield* stills.stills(projectId)).key, first.key);
        assert.strictEqual(calls.length, 1);

        yield* apply(edits, projectId, [captions(["new words"])]);
        const changed = yield* stills.stills(projectId);
        assert.notStrictEqual(changed.key, first.key);
        assert.strictEqual(calls.length, 2);

        yield* edits.undo(projectId);
        const undone = yield* stills.stills(projectId);
        assert.deepStrictEqual(undone, first);
        assert.strictEqual(calls.length, 2);
        // No temp folder is left behind.
        const left = NodeFS.readdirSync(NodePath.join(root, ".s7cache", "captions"));
        assert.deepStrictEqual(
          left.filter((name) => name.startsWith(".tmp")),
          [],
        );
      }),
    ),
  );

  it.effect("a muted caption track, or none, has no stills and calls no engine", () =>
    withStills(({ projectId, calls, edits, stills }) =>
      Effect.gen(function* () {
        yield* apply(edits, projectId, setup);
        assert.deepStrictEqual((yield* stills.stills(projectId)).chunks, []);
        yield* apply(edits, projectId, [
          captions(["hello"]),
          { _tag: "setTrackProps", trackId: "C1", props: { muted: true } },
        ]);
        const muted = yield* stills.stills(projectId);
        assert.deepStrictEqual(
          { chunks: muted.chunks, stills: muted.stills },
          { chunks: [], stills: [] },
        );
        assert.strictEqual(calls.length, 0);
      }),
    ),
  );
});
