// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A dev fixture generator; no Effect runtime.
// Deterministic synthetic clips (testsrc2 video + tone/silence audio) generated into the test-media
// cache, never the repo. CLI: `node fixtures/media/synth.ts --spec '<SynthSpec JSON>'` prints the
// path (pytest's `harness.synth` uses it). Uses the developer's FFmpeg (S7VIDEO_FFMPEG or PATH);
// its libx264 is GPL and dev only, never shipped.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { testMediaDir } from "../../scripts/lib/test-media.ts";

/** One stretch of the audio pattern: a sine tone when `toneHz` is set, otherwise silence. */
export interface SynthSegment {
  readonly seconds: number;
  readonly toneHz?: number;
  /** Peak level of the tone in dBFS (default −20). A stereo 1 kHz tone at −20 dBFS reads −20 LUFS. */
  readonly dbfs?: number;
}

export interface SynthSpec {
  /** File-name prefix, `[a-z0-9-]`. */
  readonly name: string;
  /** Video frame rate as a rational, e.g. `"30/1"` or `"30000/1001"`. Default `"30/1"`. */
  readonly fps?: string;
  /** Keyframe interval in frames (closed GOP, no B-frames). Default: one second of frames. */
  readonly gop?: number;
  readonly width?: number;
  readonly height?: number;
  /** The audio pattern; its total length is the clip's length. */
  readonly audio: ReadonlyArray<SynthSegment>;
  /** `mp4`: H.264 + AAC; `mov`: H.264 + 16-bit PCM; `wav`: 16-bit PCM audio only. Default `mp4`. */
  readonly container?: "mp4" | "mov" | "wav";
  readonly sampleRate?: number;
  readonly channels?: 1 | 2;
}

// Bump when the FFmpeg arguments change, so cached clips from the old recipe are not reused.
const RECIPE_VERSION = 1;

function parseRate(fps: string): { num: number; den: number } {
  const match = /^(\d+)\/(\d+)$/.exec(fps);
  if (!match) throw new Error(`fps must be a rational like "30/1", got ${JSON.stringify(fps)}`);
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (num <= 0 || den <= 0) throw new Error(`fps must be positive, got ${fps}`);
  return { num, den };
}

function validate(spec: SynthSpec): void {
  if (!/^[a-z0-9-]+$/.test(spec.name)) throw new Error(`name must match [a-z0-9-]+: ${spec.name}`);
  if (spec.audio.length === 0) throw new Error("audio needs at least one segment");
  for (const segment of spec.audio) {
    if (!(segment.seconds > 0)) throw new Error("every audio segment needs seconds > 0");
  }
  if (spec.gop !== undefined && !(Number.isInteger(spec.gop) && spec.gop > 0)) {
    throw new Error(`gop must be a positive integer, got ${String(spec.gop)}`);
  }
}

/** The audio expression for FFmpeg `aevalsrc`: each tone gated to its own time span. */
export function audioExpression(audio: ReadonlyArray<SynthSegment>): string {
  let at = 0;
  const terms: string[] = [];
  for (const segment of audio) {
    const end = at + segment.seconds;
    if (segment.toneHz !== undefined) {
      const amplitude = 10 ** ((segment.dbfs ?? -20) / 20);
      terms.push(
        `gte(t,${at})*lt(t,${end})*${amplitude.toPrecision(9)}*sin(2*PI*${segment.toneHz}*t)`,
      );
    }
    at = end;
  }
  return terms.length > 0 ? terms.join("+") : "0";
}

export function totalSeconds(spec: SynthSpec): number {
  return spec.audio.reduce((sum, segment) => sum + segment.seconds, 0);
}

/** FFmpeg arguments that write `spec` to `output`. Pure, so tests can check the recipe. */
export function ffmpegArgs(spec: SynthSpec, output: string): string[] {
  validate(spec);
  const fps = spec.fps ?? "30/1";
  const { num, den } = parseRate(fps);
  const container = spec.container ?? "mp4";
  const seconds = totalSeconds(spec);
  const channels = spec.channels ?? 2;
  const sampleRate = spec.sampleRate ?? 48_000;
  const expr = audioExpression(spec.audio);
  const audioSource = `aevalsrc='${Array.from({ length: channels }, () => expr).join("|")}':s=${sampleRate}:d=${seconds}`;
  const args = ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", audioSource];
  if (container !== "wav") {
    const gop = spec.gop ?? Math.round(num / den);
    const size = `${spec.width ?? 320}x${spec.height ?? 180}`;
    args.push("-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${fps}:duration=${seconds}`);
    args.push("-map", "1:v", "-map", "0:a");
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "1",
      "-g",
      String(gop),
      "-keyint_min",
      String(gop),
      "-sc_threshold",
      "0",
      "-bf",
      "0",
      "-r",
      fps,
    );
  }
  args.push(
    "-c:a",
    container === "mp4" ? "aac" : "pcm_s16le",
    ...(container === "mp4" ? ["-b:a", "192k"] : []),
    "-ar",
    String(sampleRate),
    "-t",
    String(seconds),
    "-map_metadata",
    "-1",
    "-fflags",
    "+bitexact",
    "-flags",
    "+bitexact",
    output,
  );
  return args;
}

/** Where `spec` is cached: `<cache>/synth/<name>-<hash of the spec and recipe>.<container>`. */
export function synthPath(spec: SynthSpec, cacheDir: string = testMediaDir()): string {
  const key = NodeCrypto.createHash("sha256")
    .update(JSON.stringify({ RECIPE_VERSION, spec }))
    .digest("hex")
    .slice(0, 12);
  return NodePath.join(cacheDir, "synth", `${spec.name}-${key}.${spec.container ?? "mp4"}`);
}

/** Generate `spec` into the cache (or reuse the cached file) and return its path. */
export function synthesize(
  spec: SynthSpec,
  options: { readonly cacheDir?: string; readonly ffmpeg?: string } = {},
): string {
  const output = synthPath(spec, options.cacheDir);
  if (NodeFS.existsSync(output)) return output;
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  const ext = NodePath.extname(output);
  const partial = `${output.slice(0, -ext.length)}.part${ext}`;
  const ffmpeg = options.ffmpeg ?? process.env.S7VIDEO_FFMPEG ?? "ffmpeg";
  const run = NodeChildProcess.spawnSync(ffmpeg, ffmpegArgs(spec, partial), { encoding: "utf8" });
  if (run.status !== 0) {
    NodeFS.rmSync(partial, { force: true });
    throw new Error(
      `ffmpeg could not generate ${spec.name}: ${run.error?.message ?? run.stderr.trim()}`,
    );
  }
  NodeFS.renameSync(partial, output);
  return output;
}

if (import.meta.main) {
  const index = process.argv.indexOf("--spec");
  const json = index === -1 ? undefined : process.argv[index + 1];
  if (json === undefined) {
    console.error("usage: node fixtures/media/synth.ts --spec '<SynthSpec JSON>'");
    process.exit(2);
  }
  try {
    console.log(synthesize(JSON.parse(json) as SynthSpec));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
