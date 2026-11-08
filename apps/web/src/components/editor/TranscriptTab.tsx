// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The Editor panel's Transcript tab (S7V-030): every word of the playing clip, the spoken one
 * highlighted, click or Enter to seek, cut words struck through. Selected words can be cut or
 * restored through `edit.apply` (S7V-038). Transcribing asks for the speech model first (S7V-026).
 */
import { LegendList } from "@legendapp/list/react";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EditDocument,
  EditOp,
  ScopedProjectRef,
  TranscribeModel,
  TranscribeModelsStatus,
} from "@t3tools/contracts";
import type { WordEdit } from "@t3tools/shared/editWordCuts";
import { AudioLinesIcon, FileTextIcon, TriangleAlertIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";

import {
  anySpeechModelReady,
  editEnvironment,
  rememberedPlayerFrame,
  requestPlayerSeek,
  subscribePlayerFrame,
  useMediaTranscript,
  useTranscriptionJobs,
} from "../../editor/editStore";
import {
  buildTranscriptModel,
  samePlayback,
  seekFrameOfWord,
  selectionSummary,
  selectionToOps,
  type TranscriptModel,
  type TranscriptPlayback,
  type TranscriptRow,
  type TranscriptSelection,
  withPendingEdit,
} from "../../editor/transcriptModel";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { type FoundModel, ModelDownloadDialog } from "./ModelDownloadDialog";
import { createTranscriptMarks, type TranscriptMarks } from "./transcriptMarks";
import type { EditApplyOutcome } from "./timeline/timelineEditor";
import { commandErrorMessage, engineErrorReason, useModelDownload } from "./useModelDownload";

/** Text edits go through `edit.apply` with origin `transcript`, as the timeline's do (S7V-038). */
export interface TranscriptEditing {
  readonly document: EditDocument;
  readonly revision: number;
  readonly apply: (ops: ReadonlyArray<EditOp>, baseRevision: number) => Promise<EditApplyOutcome>;
}

/** Shown when the edit changed between the selection and the cut (S7V-038 AC-6). */
export const TRANSCRIPT_CONFLICT_NOTICE =
  "The agent just changed this edit. Your selection was kept; try again.";

export interface TranscriptTabProps {
  readonly projectRef: ScopedProjectRef;
  /** The clip the player plays (or would play); null when the project has none. */
  readonly mediaId: string | null;
  /** The player's rate and kept ranges; null when nothing plays and nothing is cut. */
  readonly playback: TranscriptPlayback | null;
  /** Present when the words can be edited: the edit plays, and no clip or version is previewed. */
  readonly editing?: TranscriptEditing | undefined;
}

function Message(props: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly description: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">{props.icon}</EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
      {props.children}
    </Empty>
  );
}

/** "Not transcribed yet", Transcribe, its progress, and the one-time model question. */
function TranscribePrompt(props: {
  readonly projectRef: ScopedProjectRef;
  readonly mediaId: string;
}) {
  const { environmentId, projectId } = props.projectRef;
  const run = useAtomCommand(editEnvironment.transcribeRun, { reportFailure: false });
  const readStatus = useAtomCommand(editEnvironment.modelsStatus, { reportFailure: false });
  const jobs = useTranscriptionJobs(environmentId, projectId);
  const model = useModelDownload(environmentId, projectId);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [asking, setAsking] = useState<TranscribeModelsStatus | null>(null);

  const askForModel = async () => {
    const status = await readStatus({ environmentId, input: {} });
    if (status._tag === "Failure") {
      setFailure(
        commandErrorMessage(squashAtomCommandFailure(status), "The speech model can't be checked."),
      );
      return false;
    }
    if (anySpeechModelReady(status.value)) return true;
    model.reset();
    setAsking(status.value);
    return false;
  };

  const transcribe = async (choice?: TranscribeModel) => {
    setFailure(null);
    setPending(true);
    if (choice === undefined && !(await askForModel())) {
      setPending(false);
      return;
    }
    const result = await run({
      environmentId,
      input: {
        projectId,
        media: props.mediaId,
        ...(choice === undefined ? {} : { model: choice }),
      },
    });
    setPending(false);
    if (result._tag === "Success") return;
    const error = squashAtomCommandFailure(result);
    const reason = engineErrorReason(error);
    if (reason === "models_missing") await askForModel();
    else if (reason !== "cancelled")
      setFailure(commandErrorMessage(error, "The clip couldn't be transcribed."));
  };

  const downloadModel = async (choice: TranscribeModel, reuse?: FoundModel["reuse"]) => {
    const outcome = await model.start(choice, reuse);
    if (outcome === "failed") return;
    setAsking(null);
    if (outcome === "downloaded") await transcribe(choice);
  };

  const running = jobs.transcribe !== null || pending;
  const progress = Math.round((jobs.transcribe?.progress ?? 0) * 100);

  return (
    <>
      {running ? (
        <Message
          icon={<AudioLinesIcon />}
          title="Transcribing…"
          description="Listening to the clip on this Mac. The words appear here when it's done."
        >
          <div className="flex w-full max-w-60 items-center gap-2">
            <div
              role="progressbar"
              aria-label="Transcription"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
            >
              <div className="h-full bg-primary" style={{ width: `${progress}%` }} />
            </div>
            <span className="text-xs text-muted-foreground tabular-nums">{progress}%</span>
          </div>
        </Message>
      ) : (
        <Message
          icon={<FileTextIcon />}
          title="Not transcribed yet"
          description="Transcribe the clip to read what was said and jump to any word."
        >
          <Button size="sm" variant="outline" onClick={() => void transcribe()}>
            Transcribe
          </Button>
          {failure === null ? null : (
            <p role="alert" className="text-destructive-foreground text-sm">
              {failure}
            </p>
          )}
        </Message>
      )}
      {asking === null ? null : (
        <ModelDownloadDialog
          open
          status={asking}
          state={model.state ?? { phase: "asking" }}
          onDownload={(choice) => void downloadModel(choice)}
          onUse={(found) => void downloadModel(found.model, found.reuse)}
          hideFound={model.reuseRefused}
          onCancelDownload={model.cancel}
          onDismiss={() => {
            setAsking(null);
            void model.notNow();
          }}
        />
      )}
    </>
  );
}

const WORD_CLASS =
  "cursor-pointer rounded-sm px-0.5 hover:bg-accent data-[selected]:bg-primary/30 data-[selected]:text-foreground data-[selected]:ring-1 data-[selected]:ring-primary data-[selected]:ring-inset data-[selected]:data-[current]:bg-primary/30 data-[selected]:data-[removed]:text-foreground data-[removed]:text-muted-foreground data-[removed]:line-through data-[current]:bg-primary/20 data-[current]:text-foreground group-focus-visible/transcript:data-[active]:ring-2 group-focus-visible/transcript:data-[active]:ring-ring group-focus-visible/transcript:data-[active]:ring-inset";

function Row(props: {
  readonly row: TranscriptRow;
  readonly model: TranscriptModel;
  readonly marks: TranscriptMarks;
}) {
  const { row, model, marks } = props;
  const words = [];
  for (let index = row.first; index < row.end; index += 1) {
    const word = model.words[index]!;
    words.push(
      <span
        key={index}
        id={marks.wordId(index)}
        role="option"
        aria-selected={false}
        data-word={index}
        data-removed={word.removed ? "" : undefined}
        className={WORD_CLASS}
      >
        {word.text}
        {word.removed ? <span className="sr-only"> (removed)</span> : null}
      </span>,
      " ",
    );
  }
  return (
    <div
      role="group"
      ref={(element) => {
        if (element !== null) marks.applyToRow(row);
      }}
      className="px-3 text-sm leading-7 data-[paragraph=true]:pt-3"
      data-paragraph={row.paragraphStart}
    >
      {words}
    </div>
  );
}

const secondsOf = (frames: number, fps: TranscriptPlayback["fps"]) =>
  ((frames * fps.den) / fps.num).toFixed(1);

const countWords = (count: number) => (count === 1 ? "1 word" : `${count} words`);

/** The note when a cut took more than the selection, so the video doesn't flicker. */
function widenedNote(
  model: TranscriptModel,
  edit: Extract<WordEdit, { _tag: "cut" }>,
  fps: TranscriptPlayback["fps"],
): string | null {
  const { widenedFrames, widenedWords } = edit.cut;
  if (widenedFrames === 0) return null;
  if (widenedWords.length > 0) {
    const text = widenedWords.map((index) => model.words[index]?.text ?? "").join(" ");
    return `Also cut “${text}” so the video doesn't flicker.`;
  }
  return `Also cut ${secondsOf(widenedFrames, fps)} s between these words so the video doesn't flicker.`;
}

function TranscriptWords(props: {
  readonly projectKey: string;
  readonly mediaId: string;
  readonly model: TranscriptModel;
  readonly playback: TranscriptPlayback | null;
  readonly editing: TranscriptEditing | undefined;
}) {
  const { projectKey, mediaId, playback, editing } = props;
  const segments = playback?.segments ?? null;
  const idPrefix = `${useId()}w`;
  const [marks] = useState(() => createTranscriptMarks(idPrefix));
  const [announcement, setAnnouncement] = useState("");
  // The selection the action bar offers; the words' marks follow it outside React.
  const [selected, setSelected] = useState<TranscriptSelection | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A text edit on its way, shown at once; dropped when the new edit arrives or the apply fails.
  const [pending, setPending] = useState<{
    readonly edit: WordEdit;
    readonly model: TranscriptModel;
  } | null>(null);
  if (pending !== null && pending.model !== props.model) setPending(null);
  const model = pending === null ? props.model : withPendingEdit(props.model, pending.edit);
  const editable =
    editing !== undefined &&
    playback !== null &&
    playback.fps.num * editing.document.fps.den === editing.document.fps.num * playback.fps.den;
  const listRoot = useRef<HTMLElement | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the model to the highlight, which runs outside React from the player's frame listener
  useEffect(() => {
    marks.update(model, segments ?? []);
  }, [marks, model, segments]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the player's frames (outside React) and starts from where it last paused
  useEffect(() => {
    marks.showFrame(rememberedPlayerFrame(projectKey));
    return subscribePlayerFrame(projectKey, marks.showFrame);
  }, [marks, projectKey]);

  const activate = (index: number) => {
    marks.setActive(index);
    if (segments === null) return;
    const frame = seekFrameOfWord(model, segments, index);
    if (frame === null) return;
    requestPlayerSeek(projectKey, frame);
    const word = model.words[index];
    setAnnouncement(
      word?.removed ? `“${word.text}” was cut. The player moved to the next kept word.` : "",
    );
  };

  const select = (anchor: number, focus: number) => {
    marks.setSelection(anchor, focus);
    setSelected({ first: Math.min(anchor, focus), last: Math.max(anchor, focus) });
    setNotice(null);
  };
  const clearSelection = () => {
    marks.clearSelection();
    setSelected(null);
  };

  const run = async (action: "cut" | "restore", selection: TranscriptSelection) => {
    if (!editable || editing === undefined || pending !== null) return;
    const edit = selectionToOps(model, selection, editing.document, mediaId, action);
    if (edit._tag === "nothing") {
      setNotice(action === "cut" ? "Those words are already cut." : "Those words already play.");
      return;
    }
    setPending({ edit, model: props.model });
    setNotice(null);
    listRoot.current?.focus({ preventScroll: true });
    const outcome = await editing.apply(edit.ops, editing.revision);
    if (outcome._tag !== "applied" || outcome.revision === editing.revision) setPending(null);
    switch (outcome._tag) {
      case "applied": {
        clearSelection();
        const count = edit._tag === "cut" ? edit.cut.words.length : edit.restore.words.length;
        const note =
          edit._tag === "cut" && playback !== null ? widenedNote(model, edit, playback.fps) : null;
        setNotice(note);
        setAnnouncement(
          `${edit._tag === "cut" ? "Cut" : "Restored"} ${countWords(count)}.${note === null ? "" : ` ${note}`}`,
        );
        return;
      }
      case "conflict":
        setNotice(TRANSCRIPT_CONFLICT_NOTICE);
        return;
      case "refused":
      case "failed":
        setNotice(outcome.message);
        return;
    }
  };

  /** Cut when a selected word plays, else restore. */
  const cutOrRestore = (selection: TranscriptSelection) => {
    const { kept } = selectionSummary(model, selection);
    void run(kept > 0 ? "cut" : "restore", selection);
  };

  const wordIndexOf = (target: EventTarget | null) => {
    const element = target instanceof Element ? target.closest("[data-word]") : null;
    const index = Number(element?.getAttribute("data-word") ?? Number.NaN);
    return Number.isInteger(index) ? index : null;
  };

  // A press on a word starts a drag selection; without a move it is a click, which seeks.
  const drag = useRef<{ anchor: number; moved: boolean } | null>(null);
  const dragged = useRef(false);

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    const index = wordIndexOf(event.target);
    if (index === null) return;
    if (event.shiftKey && editable) {
      const from = marks.selection()?.anchor ?? marks.active();
      select(from === -1 ? index : from, index);
      marks.setActive(index);
      return;
    }
    if (selected !== null) clearSelection();
    activate(index);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null || (event.buttons & 1) === 0) return;
    const index = wordIndexOf(event.target);
    if (index === null || (index === current.anchor && !current.moved)) return;
    current.moved = true;
    marks.setSelection(current.anchor, index);
  };

  const endDrag = () => {
    const current = drag.current;
    drag.current = null;
    const selection = marks.selection();
    if (current?.moved !== true || selection === null) return;
    dragged.current = true;
    select(selection.anchor, selection.focus);
    marks.setActive(selection.focus);
  };

  const firstVisibleWord = (root: HTMLElement) => {
    const top = root.getBoundingClientRect().top;
    for (const element of root.querySelectorAll("[data-word]")) {
      if (element.getBoundingClientRect().bottom > top)
        return Number(element.getAttribute("data-word"));
    }
    return 0;
  };

  /** The keyboard's first word: the playing one, else the first on screen. */
  const ensureActive = (root: HTMLElement) => {
    if (marks.active() !== -1) return;
    const current = marks.current();
    marks.setActive(current !== -1 ? current : firstVisibleWord(root));
  };

  // A mouse focus leaves the list where it is: scrolling to the playing word between press and
  // release would move the click off the word the user aimed at, which then becomes active.
  const pointerFocus = useRef(false);

  const onFocus = (event: React.FocusEvent<HTMLDivElement>) => {
    const fromPointer = pointerFocus.current;
    pointerFocus.current = false;
    if (event.target !== event.currentTarget || fromPointer) return;
    ensureActive(event.currentTarget);
  };

  const rowStart = (index: number, direction: 1 | -1) => {
    const rows = model.rows;
    const at = rows.findIndex((row) => index >= row.first && index < row.end);
    const target = rows[Math.max(0, Math.min(rows.length - 1, at + direction))];
    return target?.first ?? index;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key.startsWith("Arrow") || event.key === "Enter" || event.key === " ") {
      ensureActive(event.currentTarget);
    }
    const last = model.words.length - 1;
    const active = Math.max(0, marks.active());
    const extend = event.shiftKey && editable;
    const move = (index: number) => {
      event.preventDefault();
      const next = Math.max(0, Math.min(last, index));
      if (extend) select(marks.selection()?.anchor ?? active, next);
      else if (selected !== null) clearSelection();
      marks.setActive(next);
    };
    switch (event.key) {
      case "ArrowRight":
        return move(active + 1);
      case "ArrowLeft":
        return move(active - 1);
      case "ArrowDown":
        return move(rowStart(active, 1));
      case "ArrowUp":
        return move(rowStart(active, -1));
      case "Home":
        return move(0);
      case "End":
        return move(last);
      case "Enter":
      case " ":
        event.preventDefault();
        activate(active);
        return;
      case "Escape":
        if (selected !== null) {
          event.preventDefault();
          clearSelection();
        }
        return;
      case "Delete":
      case "Backspace":
        if (!editable || marks.active() === -1) return;
        event.preventDefault();
        cutOrRestore(selected ?? { first: active, last: active });
        return;
      case "PageUp":
      case "PageDown":
        marks.noteUserScroll();
        return;
    }
  };

  const allCut = model.words.length > 0 && model.removedCount === model.words.length;
  const summary = selected === null || !editable ? null : selectionSummary(model, selected);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {allCut ? (
        <p className="shrink-0 px-3 py-2 text-muted-foreground text-sm">
          {editable
            ? "Every word was cut, so nothing plays. Select words and choose Restore to bring them back."
            : "Every word was cut, so nothing plays. Ask the agent to restore a part."}
        </p>
      ) : null}
      {summary !== null && selected !== null && summary.kept + summary.removed > 0 ? (
        <div
          role="toolbar"
          aria-label="Selected words"
          className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5"
        >
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
            {countWords(summary.kept + summary.removed)} selected
          </span>
          {summary.kept > 0 ? (
            <Button
              size="compact"
              variant="outline"
              disabled={pending !== null}
              aria-keyshortcuts="Delete Backspace"
              onClick={() => void run("cut", selected)}
            >
              Cut <Kbd>⌫</Kbd>
            </Button>
          ) : null}
          {summary.removed > 0 ? (
            <Button
              size="compact"
              variant="outline"
              disabled={pending !== null}
              aria-keyshortcuts={summary.kept > 0 ? undefined : "Delete Backspace"}
              onClick={() => void run("restore", selected)}
            >
              Restore {summary.kept > 0 ? null : <Kbd>⌫</Kbd>}
            </Button>
          ) : null}
        </div>
      ) : null}
      {notice === null ? null : (
        <p role="status" className="shrink-0 px-3 py-1.5 text-muted-foreground text-xs">
          {notice}
        </p>
      )}
      <div
        ref={(element) => {
          listRoot.current = element;
          marks.attachRoot(element);
        }}
        role="listbox"
        aria-label="Transcript"
        aria-multiselectable={editable ? true : undefined}
        aria-describedby={`${idPrefix}-help`}
        tabIndex={0}
        className="group/transcript min-h-0 flex-1 select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={onClick}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onWheel={() => marks.noteUserScroll()}
        onTouchMove={() => marks.noteUserScroll()}
        onPointerDown={(event) => {
          pointerFocus.current = true;
          marks.noteUserScroll();
          dragged.current = false;
          const index = wordIndexOf(event.target);
          drag.current =
            editable && event.button === 0 && !event.shiftKey && index !== null
              ? { anchor: index, moved: false }
              : null;
        }}
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          pointerFocus.current = false;
          endDrag();
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <LegendList<TranscriptRow>
          ref={(list) => marks.attachList(list)}
          data={model.rows}
          extraData={model}
          keyExtractor={(row) => row.key}
          renderItem={({ item }) => <Row row={item} model={model} marks={marks} />}
          estimatedItemSize={88}
          recycleItems={false}
          className="h-full"
          ListFooterComponent={<div className="h-3" />}
        />
      </div>
      <p id={`${idPrefix}-help`} className="sr-only">
        {editable
          ? "Arrow keys move between words; Enter plays from the word. Shift with the arrow keys selects words; Delete cuts them, or restores cut ones."
          : "Arrow keys move between words; Enter plays from the word."}
      </p>
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

export function TranscriptTab(props: TranscriptTabProps) {
  const { projectRef, mediaId, editing } = props;
  const state = useMediaTranscript(projectRef, mediaId);
  // Kept while the frames played stay the same, so the model and its rows are not rebuilt.
  const [playback, setPlayback] = useState(props.playback);
  if (!samePlayback(playback, props.playback)) setPlayback(props.playback);
  if (mediaId === null) {
    return (
      <Message
        icon={<FileTextIcon />}
        title="No clip yet"
        description="Add a clip to read what was said, word by word."
      />
    );
  }
  switch (state._tag) {
    case "loading":
      return (
        <div
          role="status"
          aria-label="Loading the transcript"
          className="flex h-full items-center justify-center"
        >
          <Spinner />
        </div>
      );
    case "error":
      return (
        <Message
          icon={<TriangleAlertIcon />}
          title="Transcript unavailable"
          description={state.message}
        />
      );
    case "ready":
      break;
  }
  const { transcript } = state;
  if (transcript === null) return <TranscribePrompt projectRef={projectRef} mediaId={mediaId} />;
  if (transcript.words.length === 0) {
    return (
      <Message
        icon={<AudioLinesIcon />}
        title="No speech found"
        description="The clip was transcribed, and nobody speaks in it."
      />
    );
  }
  return (
    <TranscriptWords
      projectKey={scopedProjectKey(projectRef)}
      mediaId={mediaId}
      model={buildTranscriptModel(transcript, playback)}
      playback={playback}
      editing={editing}
    />
  );
}
