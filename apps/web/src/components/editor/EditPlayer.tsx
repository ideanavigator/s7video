// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The Editor panel's player (S7V-029): plays the edit by skipping its cuts (`editPlaybackLoop`).
 * Native controls are off, since their scrubber would show the uncut source.
 */
import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon } from "lucide-react";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";

import { formatPlaybackClock, type PlaybackPlan } from "../../editor/editPlayback";
import { createPlaybackLoop, type PlaybackLoop } from "../../editor/editPlaybackLoop";
import { publishPlayerFrame, subscribePlayerSeek } from "../../editor/editStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export interface EditPlayerProps {
  readonly projectKey: string;
  readonly src: string;
  readonly label: string;
  readonly plan: PlaybackPlan;
  /** Edit frame to show first, where this project's player last paused. */
  readonly startFrame: number;
  readonly onPositionChange: (frame: number) => void;
  readonly onPlayingChange?: ((playing: boolean) => void) | undefined;
  /** The first frame decoded, so the source plays. */
  readonly onLoaded?: (() => void) | undefined;
  readonly onError: () => void;
  /** Drawn over the video inside the canvas: the edit's captions (S7V-075). */
  readonly overlay?: ReactNode;
}

/**
 * An edit plays inside its canvas, filled and cropped from the centre as export renders it
 * (S7V-061), with black bars in the 16:9 frame around any other shape. A raw clip plays whole.
 */
export function CanvasFrame(props: {
  readonly canvas: PlaybackPlan["canvas"] | undefined;
  readonly children: ReactNode;
}) {
  const { canvas } = props;
  if (canvas === undefined) return props.children;
  const ratio = canvas.width / canvas.height;
  return (
    // Out of flow and size-contained, so the video never stretches the frame, and the canvas fits
    // both of the frame's sides, whatever shape `max-h` gives the frame.
    <div className="absolute inset-0 flex items-center justify-center [container-type:size]">
      <div
        data-canvas={`${canvas.width}x${canvas.height}`}
        className="relative overflow-hidden"
        style={{
          aspectRatio: `${canvas.width} / ${canvas.height}`,
          width: `min(100cqw, ${ratio} * 100cqh)`,
        }}
      >
        {props.children}
      </div>
    </div>
  );
}

const stepSize = (event: KeyboardEvent, plan: PlaybackPlan) =>
  event.shiftKey ? Math.round(plan.fps.num / plan.fps.den) : 1;

export function EditPlayer(props: EditPlayerProps) {
  const { plan, projectKey, onPositionChange, onPlayingChange } = props;
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [loop, setLoop] = useState<PlaybackLoop | null>(null);
  const [playing, setPlayingState] = useState(false);
  const setPlaying = (next: boolean) => {
    setPlayingState(next);
    onPlayingChange?.(next);
  };
  const [clock, setClock] = useState(props.startFrame);

  const attachVideo = (element: HTMLVideoElement) => {
    const created = createPlaybackLoop(element, {
      onFrame: (frame) => publishPlayerFrame(projectKey, frame),
      onEnd: () => setPlaying(false),
    });
    setVideo(element);
    setLoop(created);
    return () => {
      created.dispose();
      element.pause();
      setLoop(null);
      setVideo(null);
      setPlaying(false);
    };
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the edit's plan into the video frame loop, which runs outside React, so an agent's change applies mid-playback
  useEffect(() => {
    loop?.setPlan(plan);
  }, [loop, plan]);

  const syncClock = () => {
    if (loop === null) return;
    const frame = loop.timelineFrame();
    setClock(frame);
    onPositionChange(frame);
  };

  const seek = (frame: number) => {
    if (loop === null) return;
    loop.seekToTimelineFrame(frame);
    const settled = Math.max(0, Math.min(frame, plan.durationFrames - 1));
    setClock(settled);
    onPositionChange(settled);
    publishPlayerFrame(projectKey, settled);
  };

  const seekOnRequest = useStableCallback(seek);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for seeks from outside React (a click on a transcript word)
  useEffect(() => subscribePlayerSeek(projectKey, seekOnRequest), [projectKey, seekOnRequest]);

  const togglePlay = () => {
    if (video === null || loop === null) return;
    if (video.paused) void loop.play().catch(() => setPlaying(false));
    else video.pause();
  };

  const step = (frames: number) => {
    if (loop === null) return;
    video?.pause();
    seek(loop.timelineFrame() + frames);
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
  const clockText = `${formatPlaybackClock(clock, plan.fps)} / ${formatPlaybackClock(
    plan.durationFrames,
    plan.fps,
  )}`;

  return (
    <div
      role="group"
      aria-label={`Player: ${props.label}`}
      tabIndex={0}
      className="flex min-h-0 flex-col gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onKeyDown={onKeyDown}
    >
      <div className="relative flex aspect-video max-h-[50vh] min-h-0 w-full items-center justify-center overflow-hidden rounded-md bg-black">
        <CanvasFrame canvas={plan.canvas}>
          <video
            ref={attachVideo}
            src={props.src}
            aria-label={props.label}
            playsInline
            preload="auto"
            className={cn(
              "size-full",
              plan.canvas === undefined ? "object-contain" : "object-cover",
            )}
            onLoadedMetadata={() => {
              loop?.setPlan(plan);
              loop?.seekToTimelineFrame(props.startFrame);
            }}
            onLoadedData={props.onLoaded}
            onPlay={() => setPlaying(true)}
            onPause={() => {
              setPlaying(false);
              syncClock();
            }}
            onTimeUpdate={() => {
              syncClock();
            }}
            onSeeked={() => {
              syncClock();
            }}
            onError={props.onError}
            onClick={togglePlay}
          />
          {props.overlay}
        </CanvasFrame>
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
          value={Math.min(clock, last)}
          aria-label="Position in the edit"
          aria-valuetext={formatPlaybackClock(clock, plan.fps)}
          className="mx-1 min-w-0 flex-1 accent-primary"
          onChange={(event) => seek(Number(event.currentTarget.value))}
        />
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{clockText}</span>
      </div>
    </div>
  );
}
