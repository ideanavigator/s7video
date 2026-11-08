// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Reads the transcript fixture and runs the engine's Python.
/**
 * S7V-075 check 2, AC-1: `mapCaptionWords` equals the engine's `map_words` on 20 seeded edits and
 * the `text-edit-cut` edit: always against the committed Python reference, and against Python
 * itself where uv is found (PATH or `UV`). `S7VIDEO_GOLDEN_UPDATE=1` rewrites the reference.
 */
import { type EditDocument, type EditRational, Transcript } from "@t3tools/contracts";
import { mapCaptionWords } from "@t3tools/shared/captionWords";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const REPO = NodePath.resolve(import.meta.dirname, "../../../..");
const TRANSCRIPT = NodePath.join(REPO, "fixtures/media/talking-head-01.transcript.json");
const TEXT_EDIT_CUT = NodePath.join(
  REPO,
  "packages/engine/tests/golden/references/text-edit-cut.json",
);
const REFERENCE = NodePath.join(import.meta.dirname, "captionWordsParity.reference.json");
const UPDATE = process.env.S7VIDEO_GOLDEN_UPDATE === "1";
const UV = [
  process.env.UV,
  ...(process.env.PATH ?? "").split(NodePath.delimiter).map((dir) => NodePath.join(dir, "uv")),
  "/opt/homebrew/bin/uv",
  "/usr/local/bin/uv",
].find((path) => path !== undefined && path !== "" && NodeFS.existsSync(path));

const transcript = Schema.decodeSync(Schema.fromJsonString(Transcript))(
  NodeFS.readFileSync(TRANSCRIPT, "utf8"),
);

const PYTHON = `
import json, sys
from s7engine import captions_from_words, timebase
from s7engine.methods import export
cases = json.load(sys.stdin)
out = []
for case in cases:
    edit = case["edit"]
    plan = export.plan_segments(edit, edit["canvas"]["width"], edit["canvas"]["height"])
    groups = captions_from_words.map_words(plan.segments, case["transcripts"], timebase.from_rational(edit["fps"]))
    out.append([[[w.text, w.start, w.end] for w in group] for group in groups])
json.dump(out, sys.stdout)
`;

/** A fixed sequence, so the 20 edits are the same on every run. */
function* seeded(seed: number) {
  let state = seed;
  for (;;) {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    yield state / 2 ** 31;
  }
}

const RATES: ReadonlyArray<EditRational> = [
  { num: 24000, den: 1001 },
  { num: 30000, den: 1001 },
  { num: 25, den: 1 },
  { num: 30, den: 1 },
  { num: 60, den: 1 },
];

type Placed = readonly [start: number, duration: number, sourceIn: number, media?: string];

const media = (id: string) => ({
  id,
  kind: "video" as const,
  path: `${id}.mp4`,
  fingerprint: { algorithm: "sha256-head-tail-1mib" as const, value: "0".repeat(64), size: 1 },
  probe: { durationFrames: 1_000_000, hasVideo: true, hasAudio: true },
});

const documentOf = (fps: EditRational, items: ReadonlyArray<Placed>): EditDocument =>
  ({
    version: 1,
    fps,
    canvas: { width: 1080, height: 1920 },
    media: [media("cam"), media("b"), media("silent")],
    tracks: [
      {
        kind: "video",
        id: "V1",
        items: items.map(([start, duration, sourceIn, from], index) => ({
          id: `v${index + 1}`,
          media: from ?? "cam",
          start,
          duration,
          in: sourceIn,
        })),
      },
    ],
    markers: [],
    metadata: {},
  }) as unknown as EditDocument;

/** Keep ranges of the clip end to end, some with a split, a gap, a second clip or no transcript. */
function seededEdits(): EditDocument[] {
  const random = seeded(75);
  const next = () => random.next().value!;
  const edits: EditDocument[] = [];
  for (let index = 0; index < 20; index++) {
    const fps = RATES[index % RATES.length]!;
    const sourceFrames = Math.floor(
      (transcript.durationFrames * fps.num * transcript.fps.den) / (fps.den * transcript.fps.num),
    );
    const items: Placed[] = [];
    let at = 0;
    let source = Math.floor(next() * 40);
    while (source < sourceFrames - 10 && items.length < 30) {
      const length = 5 + Math.floor(next() * 120);
      const duration = Math.min(length, sourceFrames - source);
      const roll = next();
      const from = roll < 0.1 ? "b" : roll < 0.15 ? "silent" : "cam";
      if (next() < 0.2 && duration > 10) {
        // A split: two items that continue their source exactly, one run for the captions.
        const half = Math.floor(duration / 2);
        items.push([at, half, source, from], [at + half, duration - half, source + half, from]);
      } else {
        items.push([at, duration, source, from]);
      }
      at += duration + (next() < 0.15 ? 1 + Math.floor(next() * 20) : 0);
      source += duration + Math.floor(next() * 60);
    }
    edits.push(documentOf(fps, items));
  }
  return edits;
}

const textEditCut = (): EditDocument => {
  const reference = JSON.parse(NodeFS.readFileSync(TEXT_EDIT_CUT, "utf8")) as {
    readonly items: ReadonlyArray<Placed>;
  };
  return documentOf({ num: 30000, den: 1001 }, reference.items);
};

const pythonGroups = (cases: ReadonlyArray<unknown>) =>
  JSON.parse(
    NodeChildProcess.execFileSync(
      UV!,
      ["run", "--frozen", "--project", "packages/engine", "python", "-I", "-c", PYTHON],
      { cwd: REPO, input: JSON.stringify(cases), maxBuffer: 64 * 1024 * 1024 },
    ).toString(),
  ) as unknown;

const words = transcript.words.map(({ text, startFrame, endFrame }) => ({
  text,
  startFrame,
  endFrame,
}));
const entry = { fps: transcript.fps, words };
const edits = () => [...seededEdits(), textEditCut()];

const typescriptGroups = () => {
  const transcripts = new Map([
    ["cam", entry],
    ["b", entry],
  ]);
  return edits().map((edit) =>
    mapCaptionWords(edit, transcripts).map((group) =>
      group.map((word) => [word.text, word.start, word.end]),
    ),
  );
};

const enginesGroups = () =>
  pythonGroups(
    edits().map((edit) => ({
      edit,
      transcripts: { cam: { media: "cam", ...entry }, b: { media: "b", ...entry } },
    })),
  );

describe("captionItemsFor parity with the engine", () => {
  it("should map every word like map_words, as the committed Python reference records it", () => {
    expect(textEditCut().tracks[0]!.items.at(-1)).toMatchObject({ start: 443, duration: 3636 });
    const actual = typescriptGroups();
    expect(actual.flat(2).length).toBeGreaterThan(2000);
    expect(actual).toEqual(JSON.parse(NodeFS.readFileSync(REFERENCE, "utf8")));
  });

  // Shown as skipped, never silently passed, where uv is missing; the test above still runs.
  it.skipIf(UV === undefined)(
    "should map every word like map_words run now, which matches the reference",
    () => {
      const expected = enginesGroups();
      if (UPDATE) NodeFS.writeFileSync(REFERENCE, `${JSON.stringify(expected)}\n`);
      expect(typescriptGroups()).toEqual(expected);
      expect(expected).toEqual(JSON.parse(NodeFS.readFileSync(REFERENCE, "utf8")));
    },
  );
});
