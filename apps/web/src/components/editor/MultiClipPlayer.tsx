// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The Editor panel's player for any timeline layout (S7V-039): several sources, gaps and reordered
 * clips, on the player clock (`playerClock.ts`). Its controls match `EditPlayer`.
 */
import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon } from "lucide-react";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";

import { formatPlaybackClock, type TimelinePlan } from "../../editor/editPlayback";
import { publishPlayerFrame, subscribePlayerSeek } from "../../editor/editStore";
import {
  createPlayerClock,
  PLAYER_POOL_SIZE,
  type PlayerClock,
  type PlayerClockEvents,
  type PlayerClockState,
} from "../../editor/playerClock";
import { useStableCallback } from "../../hooks/useStableCallback";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { CanvasFrame } from "./EditPlayer";

/** One source of the edit as the player gets it: a URL to play, or why there is none. */
export interface MultiClipSource {
  readonly label: string;
  /** `null` while it resolves, and for a missing or failed source. */
  readonly url: string | null;
  readonly status: "ready" | "loading" | "missing" | "failed";
}

export interface MultiClipPlayerProps {
  readonly projectKey: string;
  readonly plan: TimelinePlan;
  readonly sources: ReadonlyMap<string, MultiClipSource>;
  readonly label: string;
  /** Edit frame to show first, where this project's player last paused. */
  readonly startFrame: number;
  readonly onPositionChange: (frame: number) => void;
  readonly onPlayingChange?: ((playing: boolean) => void) | undefined;
  /** An element failed to load or decode a source; the panel retries it or marks it failed. */
  readonly onSourceError: (mediaId: string) => void;
  /** What to offer over an item whose source is missing or failed (Find file, Retry). */
  readonly renderSourceProblem?: ((mediaId: string) => ReactNode) | undefined;
  /** Dev and golden hook: every join the clock makes. */
  readonly onJoin?: PlayerClockEvents["onJoin"];
  /** Drawn over the video inside the canvas: the edit's captions (S7V-075). */
  readonly overlay?: ReactNode;
}

/** The clock text and slider move at most this often while playing; the playhead moves per frame. */
const CLOCK_TEXT_INTERVAL_MS = 250;

const stepSize = (event: KeyboardEvent, plan: TimelinePlan) =>
  event.shiftKey ? Math.round(plan.fps.num / plan.fps.den) : 1;

export function MultiClipPlayer(props: MultiClipPlayerProps) {
  const { plan, projectKey, sources } = props;
  const [clock, setClock] = useState<PlayerClock | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(props.startFrame);
  const [shown, setShown] = useState<PlayerClockState>({ _tag: "gap" });

  const onPositionChange = useStableCallback(props.onPositionChange);
  const onPlayingChange = useStableCallback((next: boolean) => {
    setPlaying(next);
    props.onPlayingChange?.(next);
  });
  const onSourceError = useStableCallback(props.onSourceError);
  const onJoin = useStableCallback((sample: Parameters<NonNullable<typeof props.onJoin>>[0]) =>
    props.onJoin?.(sample),
  );

  // Read at mount only, so a new plan or source map never rebuilds the clock.
  const mountState = useStableCallback(() => ({ plan, sources, startFrame: props.startFrame }));

  const attachStage = (stage: HTMLDivElement) => {
    const initial = mountState();
    const videos = [...stage.querySelectorAll("video")];
    let textAt = 0;
    const created = createPlayerClock(
      initial.plan,
      {
        videos,
        show: (index) => {
          videos.forEach((video, at) => {
            video.style.opacity = at === index ? "1" : "0";
          });
        },
        now: () => performance.now(),
        requestFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (handle) => cancelAnimationFrame(handle),
      },
      {
        onFrame: (frame) => {
          publishPlayerFrame(projectKey, frame);
          onPositionChange(frame);
          const now = performance.now();
          if (!created.playing() || now - textAt >= CLOCK_TEXT_INTERVAL_MS) {
            textAt = now;
            setPosition(frame);
          }
        },
        onPlayingChange: (next) => {
          onPlayingChange(next);
          setPosition(created.frame());
        },
        onStateChange: setShown,
        onSourceError,
        onJoin,
      },
    );
    for (const [mediaId, source] of initial.sources) created.setSource(mediaId, source.url);
    created.seek(initial.startFrame);
    setClock(created);
    return () => {
      created.dispose();
      setClock(null);
    };
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the edit's plan into the player clock, which runs outside React, so an agent's change applies mid-playback
  useEffect(() => {
    clock?.setPlan(plan);
  }, [clock, plan]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands each source's URL (resolved, missing or failed) to the clock outside React
  useEffect(() => {
    if (clock === null) return;
    for (const [mediaId, source] of sources) clock.setSource(mediaId, source.url);
  }, [clock, sources]);

  const seek = (frame: number) => clock?.seek(frame);
  const seekOnRequest = useStableCallback(seek);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for seeks from outside React (the timeline, a transcript word)
  useEffect(() => subscribePlayerSeek(projectKey, seekOnRequest), [projectKey, seekOnRequest]);

  const togglePlay = () => {
    if (clock === null) return;
    if (clock.playing()) clock.pause();
    else clock.play();
  };

  const step = (frames: number) => {
    if (clock === null) return;
    clock.pause();
    clock.seek(clock.frame() + frames);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === " ") {
      event.preventDefault();
      togglePlay();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      step((event.key === "ArrowLeft" ? -1 : 1) * stepSize(event, plan));
    }
  };

  const last = Math.max(0, plan.durationFrames - 1);
  const clockText = `${formatPlaybackClock(position, plan.fps)} / ${formatPlaybackClock(
    plan.durationFrames,
    plan.fps,
  )}`;
  const problem = shown._tag === "missing" ? (sources.get(shown.mediaId) ?? null) : null;

  return (
    <div
      role="group"
      aria-label={`Player: ${props.label}`}
      tabIndex={0}
      className="flex min-h-0 flex-col gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onKeyDown={onKeyDown}
    >
      <div className="relative flex aspect-video max-h-[50vh] w-full items-center justify-center overflow-hidden rounded-md bg-black">
        <CanvasFrame canvas={plan.canvas}>
          <div ref={attachStage} className="relative size-full" data-testid="multi-clip-stage">
            {Array.from({ length: PLAYER_POOL_SIZE }, (_, index) => (
              <video
                key={index}
                aria-hidden
                data-player-slot={index}
                playsInline
                muted
                preload="auto"
                // Hidden by opacity, not display, so a parked element keeps its decoded frame.
                style={{ opacity: 0 }}
                className={cn(
                  "absolute inset-0 size-full",
                  plan.canvas === undefined ? "object-contain" : "object-cover",
                )}
                onClick={togglePlay}
              />
            ))}
          </div>
          {props.overlay}
        </CanvasFrame>
        {problem !== null && shown._tag === "missing" ? (
          <div
            role="status"
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-white"
          >
            <span>
              {problem.status === "failed"
                ? `${problem.label} can't be played. The file may be damaged or in a format this Mac can't play.`
                : problem.status === "loading"
                  ? `Opening ${problem.label}…`
                  : `Clip not found: ${problem.label}`}
            </span>
            {problem.status === "loading" ? null : props.renderSourceProblem?.(shown.mediaId)}
          </div>
        ) : null}
        {shown._tag === "preparing" ? (
          <span
            role="status"
            className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white"
          >
            Preparing next clip…
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-1 px-1">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={playing ? "Pause" : "Play"}
          onClick={togglePlay}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Previous frame" onClick={() => step(-1)}>
          <ChevronLeftIcon />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Next frame" onClick={() => step(1)}>
          <ChevronRightIcon />
        </Button>
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={Math.min(position, last)}
          aria-label="Position in the edit"
          aria-valuetext={formatPlaybackClock(position, plan.fps)}
          className="mx-1 min-w-0 flex-1 accent-primary"
          onChange={(event) => seek(Number(event.currentTarget.value))}
        />
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{clockText}</span>
      </div>
    </div>
  );
}
