// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The timeline playhead (S7V-033): one element moved by `transform`, outside React. It hears the
 * player's presented frames through `subscribePlayerFrame` (published from
 * `requestVideoFrameCallback` while playing, and once per seek), so nothing runs while paused.
 */
import { subscribePlayerFrame } from "../../../editor/editStore";
import type { PlaybackPlan } from "../../../editor/editPlayback";
import { playerFrameToEditFrame } from "./editFrames";

export interface PlayheadDriver {
  /** The playhead element, or null when it unmounts. */
  readonly attach: (element: HTMLElement | null) => void;
  readonly setPxPerFrame: (pxPerFrame: number) => void;
  /** Hidden while the player shows a single clip, whose frames are not edit frames. */
  readonly setVisible: (visible: boolean) => void;
  /** Moves the playhead now, before the player confirms a seek. */
  readonly place: (editFrame: number) => void;
  readonly frame: () => number;
  readonly setPlan: (plan: PlaybackPlan | null) => void;
  /** Starts hearing the player's frames; returns the stop. */
  readonly connect: () => () => void;
}

export interface PlayheadDriverOptions {
  readonly projectKey: string;
  readonly initialFrame: number;
  readonly pxPerFrame: number;
  /** Every placed frame, after the element moved. */
  readonly onFrame?: (editFrame: number) => void;
}

export function createPlayheadDriver(options: PlayheadDriverOptions): PlayheadDriver {
  let element: HTMLElement | null = null;
  let frame = options.initialFrame;
  let pxPerFrame = options.pxPerFrame;
  let visible = true;
  let plan: PlaybackPlan | null = null;

  const render = () => {
    if (element === null) return;
    element.style.transform = `translate3d(${frame * pxPerFrame}px, 0, 0)`;
    element.dataset.frame = String(frame);
  };

  const place = (editFrame: number) => {
    frame = editFrame;
    render();
    options.onFrame?.(frame);
  };

  return {
    attach: (next) => {
      element = next;
      if (element !== null) element.hidden = !visible;
      render();
    },
    setPxPerFrame: (next) => {
      if (next === pxPerFrame) return;
      pxPerFrame = next;
      render();
    },
    setVisible: (next) => {
      visible = next;
      if (element !== null) element.hidden = !visible;
    },
    place,
    frame: () => frame,
    setPlan: (next) => {
      plan = next;
    },
    connect: () =>
      subscribePlayerFrame(options.projectKey, (playerFrame) => {
        if (visible) place(playerFrameToEditFrame(playerFrame, plan));
      }),
  };
}
