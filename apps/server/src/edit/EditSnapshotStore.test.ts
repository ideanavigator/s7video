// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Assertions read the store's files directly.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { type EditFaults, historyObjects, layerFaultyFileSystem } from "./editHarness.testkit.ts";
import {
  EditSnapshotStore,
  EMPTY_HISTORY_LOG,
  type HistoryFiles,
  type HistoryLog,
  layer as layerStore,
  MAX_REFUSED_EDITS,
} from "./EditSnapshotStore.ts";

const withStore = <A, E>(
  body: (input: {
    readonly root: string;
    readonly store: EditSnapshotStore["Service"];
    readonly faults: EditFaults;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-history-" });
    const faults: EditFaults = { failTempRename: false };
    return yield* Effect.gen(function* () {
      return yield* body({ root, store: yield* EditSnapshotStore, faults });
    }).pipe(Effect.provide(layerStore.pipe(Layer.provide(layerFaultyFileSystem(faults)))));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const logOf = (entries: ReadonlyArray<HistoryFiles>): HistoryLog => ({
  ...EMPTY_HISTORY_LOG,
  nextSeq: entries.length + 1,
  highestRevision: entries.length,
  cursor: entries.length - 1,
  entries: entries.map((files, index) => ({ seq: index + 1, revision: index + 1, files, at: 0 })),
});

const historyPath = (root: string, ...parts: ReadonlyArray<string>) =>
  NodePath.join(root, ".s7history", ...parts);

const tempFiles = (root: string) =>
  NodeFS.readdirSync(historyPath(root), { recursive: true }).filter((name) =>
    String(name).endsWith(".tmp"),
  );

describe("EditSnapshotStore", () => {
  it.effect("saves one object per distinct text and reads it back exactly", () =>
    withStore(({ root, store }) =>
      Effect.gen(function* () {
        const editJson = '{\n  "version": 1,\n  "title": "Café ☕ 日本"\n}\n';
        const projectJson = '{"revision":1}\n';
        const first = yield* store.put(root, { editJson, projectJson });
        const again = yield* store.put(root, { editJson, projectJson });
        assert.deepEqual(again, first);
        assert.deepEqual(
          historyObjects(root),
          [first["edit.json"], first["project.json"]].map((id) => `${id}.json.gz`).toSorted(),
        );
        assert.strictEqual(yield* store.read(root, first["edit.json"]), editJson);
        assert.strictEqual(yield* store.read(root, first["project.json"]), projectJson);
        // Same text in both files is one object.
        const same = yield* store.put(root, { editJson: projectJson, projectJson });
        assert.strictEqual(same["edit.json"], same["project.json"]);
        assert.strictEqual(historyObjects(root).length, 2);
        assert.deepEqual(tempFiles(root), []);
      }),
    ),
  );

  it.effect("refuses an object whose content no longer matches its name", () =>
    withStore(({ root, store }) =>
      Effect.gen(function* () {
        const files = yield* store.put(root, { editJson: "a\n", projectJson: "b\n" });
        NodeFS.writeFileSync(
          historyPath(root, "objects", `${files["edit.json"]}.json.gz`),
          NodeZlib.gzipSync("tampered\n"),
        );
        const error = yield* store.read(root, files["edit.json"]).pipe(Effect.flip);
        assert.strictEqual(error.reason, "checkpoint-failed");
        const missing = yield* store.read(root, "0".repeat(64)).pipe(Effect.flip);
        assert.strictEqual(missing.reason, "checkpoint-failed");
      }),
    ),
  );

  it.effect("writes the log atomically", () =>
    withStore(({ root, store, faults }) =>
      Effect.gen(function* () {
        assert.deepEqual(yield* store.readLog(root), EMPTY_HISTORY_LOG);
        const files = yield* store.put(root, { editJson: "a\n", projectJson: "b\n" });
        const first = logOf([files]);
        yield* store.writeLog(root, first);
        assert.deepEqual(yield* store.readLog(root), first);
        assert.deepEqual(tempFiles(root), []);

        // A failed rename (a crash before it) leaves the old log whole and no temp file.
        faults.failTempRenameOf = "log.json";
        const error = yield* store.writeLog(root, logOf([files, files])).pipe(Effect.flip);
        delete faults.failTempRenameOf;
        assert.strictEqual(error.reason, "state-write-failed");
        assert.deepEqual(yield* store.readLog(root), first);
        assert.deepEqual(tempFiles(root), []);
      }),
    ),
  );

  it.effect("reads a missing, damaged or inconsistent log as an empty one", () =>
    withStore(({ root, store }) =>
      Effect.gen(function* () {
        const files = yield* store.put(root, { editJson: "a\n", projectJson: "b\n" });
        const damaged = [
          "not json",
          JSON.stringify({ ...logOf([files]), format: "git" }),
          JSON.stringify({ ...logOf([files]), cursor: 3 }),
          JSON.stringify({ ...logOf([]), cursor: 0 }),
        ];
        for (const text of damaged) {
          NodeFS.writeFileSync(historyPath(root, "log.json"), text);
          assert.deepEqual(yield* store.readLog(root), EMPTY_HISTORY_LOG, text);
        }
      }),
    ),
  );

  it.effect("fails, rather than reading as empty, a log it cannot open", () =>
    withStore(({ root, store }) =>
      Effect.gen(function* () {
        const files = yield* store.put(root, { editJson: "a\n", projectJson: "b\n" });
        yield* store.writeLog(root, logOf([files]));
        const log = historyPath(root, "log.json");
        NodeFS.chmodSync(log, 0o000);
        const error = yield* store
          .readLog(root)
          .pipe(Effect.flip, Effect.ensuring(Effect.sync(() => NodeFS.chmodSync(log, 0o644))));
        assert.strictEqual(error.reason, "state-read-failed");
        assert.deepEqual(yield* store.readLog(root), logOf([files]));
      }),
    ),
  );

  it.effect("collects only objects the log does not name", () =>
    withStore(({ root, store }) =>
      Effect.gen(function* () {
        const steps: HistoryFiles[] = [];
        for (const n of [1, 2, 3]) {
          steps.push(
            yield* store.put(root, { editJson: `{"edit":${n}}\n`, projectJson: `{"rev":${n}}\n` }),
          );
        }
        // A crash left a temp object; a stranger's file sits next to the store.
        NodeFS.writeFileSync(historyPath(root, "objects", ".x.json.gz.1.tmp"), "half");
        NodeFS.writeFileSync(historyPath(root, "notes.txt"), "mine");
        // A crash before a log rename left its temp file next to log.json.
        NodeFS.writeFileSync(historyPath(root, ".log.json.dead-beef.tmp"), "stale");
        NodeFS.writeFileSync(historyPath(root, ".other.tmp"), "not ours");
        NodeFS.writeFileSync(NodePath.join(root, "edit.json"), "{}");
        const dropped = steps[1]!;
        const droppedBytes = [dropped["edit.json"], dropped["project.json"]]
          .map((id) => NodeFS.statSync(historyPath(root, "objects", `${id}.json.gz`)).size)
          .reduce((sum, size) => sum + size, 0);

        const kept = logOf([steps[0]!, steps[2]!]);
        const collected = yield* store.collect(root, kept);
        assert.deepEqual(collected, { removedObjects: 2, freedBytes: droppedBytes + 4 + 5 });
        assert.isFalse(NodeFS.existsSync(historyPath(root, ".log.json.dead-beef.tmp")));
        assert.isTrue(NodeFS.existsSync(historyPath(root, ".other.tmp")));
        const live = [steps[0]!, steps[2]!].flatMap((files) => [
          `${files["edit.json"]}.json.gz`,
          `${files["project.json"]}.json.gz`,
        ]);
        assert.deepEqual(historyObjects(root), live.toSorted());
        assert.strictEqual(NodeFS.readFileSync(historyPath(root, "notes.txt"), "utf8"), "mine");
        assert.isTrue(NodeFS.existsSync(NodePath.join(root, "edit.json")));
        assert.deepEqual(yield* store.collect(root, kept), { removedObjects: 0, freedBytes: 0 });
      }),
    ),
  );

  it.effect("reports usage", () =>
    withStore(({ root, store }) =>
      Effect.gen(function* () {
        assert.deepEqual(yield* store.usage(root), {
          objects: 0,
          bytes: 0,
          refusedEdits: 0,
          refusedBytes: 0,
        });
        yield* store.put(root, { editJson: "a\n", projectJson: "b\n" });
        yield* store.put(root, { editJson: "c\n", projectJson: "b\n" });
        const names = historyObjects(root);
        const bytes = names
          .map((name) => NodeFS.statSync(historyPath(root, "objects", name)).size)
          .reduce((sum, size) => sum + size, 0);
        assert.deepEqual(yield* store.usage(root), {
          objects: 3,
          bytes,
          refusedEdits: 0,
          refusedBytes: 0,
        });
      }),
    ),
  );

  // S7V-054: refused outside edits are kept for the user, but never pile up.
  it.effect("keeps the newest refused edits, skips a repeat and counts them in usage", () =>
    withStore(({ root, store }) =>
      Effect.gen(function* () {
        const refused = () =>
          NodeFS.readdirSync(historyPath(root, "refused"))
            .toSorted()
            .map((name) => NodeFS.readFileSync(historyPath(root, "refused", name), "utf8"));
        yield* store.keepRefused(root, "{ first");
        yield* store.keepRefused(root, "{ first");
        assert.deepEqual(refused(), ["{ first"]);
        for (let index = 0; index < MAX_REFUSED_EDITS + 4; index++) {
          yield* store.keepRefused(root, `{ broken ${index}`);
        }
        const kept = refused();
        assert.lengthOf(kept, MAX_REFUSED_EDITS);
        assert.notInclude(kept, "{ first");
        assert.include(kept, `{ broken ${MAX_REFUSED_EDITS + 3}`);
        assert.notInclude(kept, "{ broken 3");
        const usage = yield* store.usage(root);
        assert.strictEqual(usage.refusedEdits, MAX_REFUSED_EDITS);
        assert.strictEqual(
          usage.refusedBytes,
          kept.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
        );
        // collect never touches them.
        yield* store.collect(root, logOf([]));
        assert.lengthOf(refused(), MAX_REFUSED_EDITS);
      }),
    ),
  );
});
