// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The Editor panel's Transcript tab (S7V-030): every word of the playing clip, the spoken one
 * highlighted, click or Enter to seek, cut words struck through. Read-only; editing by text is
 * S7V-038. Starting a transcription asks for the speech model first when it is missing (S7V-026).
 */
import { LegendList } from "@legendapp/list/react";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedProjectRef, TranscribeModel, TranscribeModelsStatus } from "@t3tools/contracts";
import { AudioLinesIcon, FileTextIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

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
  type TranscriptModel,
  type TranscriptPlayback,
  type TranscriptRow,
} from "../../editor/transcriptModel";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { ModelDownloadDialog } from "./ModelDownloadDialog";
import { createTranscriptMarks, type TranscriptMarks } from "./transcriptMarks";
import { commandErrorMessage, engineErrorReason, useModelDownload } from "./useModelDownload";

export interface TranscriptTabProps {
  readonly projectRef: ScopedProjectRef;
  /** The clip the player plays (or would play); null when the project has none. */
  readonly mediaId: string | null;
  /** The player's rate and kept ranges; null when nothing plays and nothing is cut. */
  readonly playback: TranscriptPlayback | null;
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

  const downloadModel = async (choice: TranscribeModel) => {
    const outcome = await model.start(choice);
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
  "cursor-pointer rounded-sm px-0.5 hover:bg-accent data-[removed]:text-muted-foreground data-[removed]:line-through data-[current]:bg-primary/20 data-[current]:text-foreground group-focus-visible/transcript:data-[active]:ring-2 group-focus-visible/transcript:data-[active]:ring-ring group-focus-visible/transcript:data-[active]:ring-inset";

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

function TranscriptWords(props: {
  readonly projectKey: string;
  readonly model: TranscriptModel;
  readonly playback: TranscriptPlayback | null;
}) {
  const { projectKey, model, playback } = props;
  const segments = playback?.segments ?? null;
  const idPrefix = `${useId()}w`;
  const [marks] = useState(() => createTranscriptMarks(idPrefix));
  const [announcement, setAnnouncement] = useState("");

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

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target.closest("[data-word]") : null;
    const index = Number(target?.getAttribute("data-word") ?? Number.NaN);
    if (Number.isInteger(index)) activate(index);
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
    const move = (index: number) => {
      event.preventDefault();
      marks.setActive(Math.max(0, Math.min(last, index)));
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
      case "PageUp":
      case "PageDown":
        marks.noteUserScroll();
        return;
    }
  };

  const allCut = model.words.length > 0 && model.removedCount === model.words.length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {allCut ? (
        <p className="shrink-0 px-3 py-2 text-muted-foreground text-sm">
          Every word was cut, so nothing plays. Ask the agent to restore a part.
        </p>
      ) : null}
      <div
        ref={(element) => marks.attachRoot(element)}
        role="listbox"
        aria-label="Transcript"
        aria-describedby={`${idPrefix}-help`}
        tabIndex={0}
        className="group/transcript min-h-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={onClick}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onWheel={() => marks.noteUserScroll()}
        onTouchMove={() => marks.noteUserScroll()}
        onPointerDown={() => {
          pointerFocus.current = true;
          marks.noteUserScroll();
        }}
        onPointerUp={() => {
          pointerFocus.current = false;
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
        Arrow keys move between words; Enter plays from the word.
      </p>
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

export function TranscriptTab(props: TranscriptTabProps) {
  const { projectRef, mediaId } = props;
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
      model={buildTranscriptModel(transcript, playback)}
      playback={playback}
    />
  );
}
