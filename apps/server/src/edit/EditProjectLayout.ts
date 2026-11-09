// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import {
  EDIT_DOCUMENT_VERSION,
  type EditCanvas,
  type EditRational,
  emptyEditDocument,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

export const EDIT_FILE = "edit.json";
export const PROJECT_FILE = "project.json";
const STYLES_DIR = "styles";
const ASSETS_DIR = "assets";
export const CACHE_DIR = ".s7cache";
const EXPORTS_DIR = "exports";
/** The edit history's own store (S7V-051); `/*` in the whitelist keeps it out of git. */
export const HISTORY_DIR = ".s7history";

/**
 * ADR-005's whitelist plus the scaffold's README and icon (PO, 2026-11-05). `/*` ignores the
 * folder `assets/` itself, and Git never looks inside an ignored folder, so `!/assets/` reopens it
 * and `/assets/*` ignores its contents again; only then can `!/assets/icon.svg` take effect.
 */
export const WHITELIST_GITIGNORE = [
  "# Only the edit is saved in history. Media, cache and exports are never tracked, so undo",
  "# cannot touch them.",
  "/*",
  "!/.gitignore",
  `!/${EDIT_FILE}`,
  `!/${PROJECT_FILE}`,
  `!/${STYLES_DIR}/`,
  "!/README.md",
  `!/${ASSETS_DIR}/`,
  `/${ASSETS_DIR}/*`,
  `!/${ASSETS_DIR}/icon.svg`,
  "",
].join("\n");

/**
 * What the whitelist `.gitignore` keeps, so T3's turn checkpoints save it: root files, and folders
 * ending in `/`. The media guard checks exactly these without asking git.
 */
export const TRACKED_PATHS: ReadonlyArray<string> = [
  ".gitignore",
  EDIT_FILE,
  PROJECT_FILE,
  "README.md",
  `${ASSETS_DIR}/icon.svg`,
  `${STYLES_DIR}/`,
];

const DEFAULT_EDIT_FPS: EditRational = { num: 30, den: 1 };
const DEFAULT_EDIT_CANVAS: EditCanvas = { width: 1080, height: 1920 };

export const EditProjectFile = Schema.Struct({
  format: Schema.Literal("edit-project"),
  version: Schema.Literal(EDIT_DOCUMENT_VERSION),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type EditProjectFile = typeof EditProjectFile.Type;

export const projectFileContents = (revision: number) =>
  `${JSON.stringify({ format: "edit-project", version: EDIT_DOCUMENT_VERSION, revision } satisfies EditProjectFile, null, 2)}\n`;

export const editFileContents = (document: unknown) => `${JSON.stringify(document, null, 2)}\n`;

/** The edit a new project starts with; an outside change to a project with no history goes back to it. */
export const STARTING_EDIT = emptyEditDocument({
  fps: DEFAULT_EDIT_FPS,
  canvas: DEFAULT_EDIT_CANVAS,
});

export class EditLayoutError extends Schema.TaggedError<EditLayoutError>()("EditLayoutError", {
  cwd: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Could not set up the edit project folders.";
  }
}

/** Whether `cwd` holds an edit project: both `edit.json` and `project.json`. */
const isEditProjectFolder =
  (fileSystem: FileSystem.FileSystem) =>
  (cwd: string): Effect.Effect<boolean> =>
    Effect.all([
      fileSystem.exists(`${cwd}/${EDIT_FILE}`),
      fileSystem.exists(`${cwd}/${PROJECT_FILE}`),
    ]).pipe(
      Effect.map(([edit, project]) => edit && project),
      Effect.orElseSucceed(() => false),
    );

const decodeProjectFormat = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ format: Schema.Literal("edit-project") })),
);

/**
 * Whether `cwd` is a video project, which gets the video tools and only them (S7V-072). Other tools
 * use a root `project.json` too, so it must also say `"format": "edit-project"`.
 */
export const isVideoProjectFolder =
  (fileSystem: FileSystem.FileSystem) =>
  (cwd: string): Effect.Effect<boolean> =>
    isEditProjectFolder(fileSystem)(cwd).pipe(
      Effect.flatMap((present) =>
        present
          ? fileSystem
              .readFileString(`${cwd}/${PROJECT_FILE}`)
              .pipe(Effect.map((text) => Option.isSome(decodeProjectFormat(text))))
          : Effect.succeed(false),
      ),
      Effect.orElseSucceed(() => false),
    );

export class EditProjectLayout extends Context.Service<
  EditProjectLayout,
  {
    /**
     * Creates whatever part of the layout is missing and never overwrites an existing file, so it
     * also upgrades a project made before the layout existed. Returns the files it wrote.
     */
    readonly ensure: (cwd: string) => Effect.Effect<ReadonlyArray<string>, EditLayoutError>;
    readonly isEditProject: (cwd: string) => Effect.Effect<boolean>;
  }
>()("t3/edit/EditProjectLayout") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const writeIfMissing = Effect.fnUntraced(function* (file: string, contents: string) {
    // `wx` fails on an existing file, so a racing or earlier write always wins.
    return yield* fileSystem.writeFileString(file, contents, { flag: "wx" }).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => PlatformError.isPlatformError(error) && error.reason._tag === "AlreadyExists",
        () => Effect.succeed(false),
      ),
    );
  });

  const ensure: EditProjectLayout["Service"]["ensure"] = Effect.fn("EditProjectLayout.ensure")(
    function* (cwd) {
      for (const folder of [STYLES_DIR, ASSETS_DIR, CACHE_DIR, EXPORTS_DIR]) {
        yield* fileSystem.makeDirectory(path.join(cwd, folder), { recursive: true });
      }
      const files: Array<readonly [string, string]> = [
        [".gitignore", WHITELIST_GITIGNORE],
        [EDIT_FILE, editFileContents(STARTING_EDIT)],
        [PROJECT_FILE, projectFileContents(0)],
      ];
      const written: string[] = [];
      for (const [name, contents] of files) {
        if (yield* writeIfMissing(path.join(cwd, name), contents)) written.push(name);
      }
      return written;
    },
    (effect, cwd) => effect.pipe(Effect.mapError((cause) => new EditLayoutError({ cwd, cause }))),
  );

  return EditProjectLayout.of({ ensure, isEditProject: isEditProjectFolder(fileSystem) });
});

export const layer = Layer.effect(EditProjectLayout, make);
