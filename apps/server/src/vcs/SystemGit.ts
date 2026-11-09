// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Whether this host has a real git, decided without starting a process (S7V-052): on a Mac without
 * the developer tools, `/usr/bin/git` and `xcrun` open Apple's install dialog. Git features follow
 * this answer, and `resolveSpawnCommand` refuses git on its own too.
 */
import { locateSystemGit } from "@t3tools/shared/shell";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export interface SystemGitStatus {
  readonly available: boolean;
  /** The git that runs, or null without one. */
  readonly path: string | null;
}

/** How often a missing git is looked for again, so installing the tools needs no restart. */
export const MISSING_GIT_RECHECK_INTERVAL = Duration.seconds(5);

const probe = Effect.gen(function* () {
  const env = yield* HostProcess.Environment;
  const location = yield* locateSystemGit(env);
  return { available: location.available, path: location.path } satisfies SystemGitStatus;
});

export class SystemGit extends Context.Reference<{
  /** The cached answer; a missing git is looked for again when the cache says no. */
  readonly status: Effect.Effect<SystemGitStatus>;
  /** Looks again now (a project was opened); tells `changes` subscribers when it differs. */
  readonly refresh: Effect.Effect<SystemGitStatus>;
  /** Every change of the answer after this subscribes. */
  readonly subscribeChanges: Effect.Effect<Stream.Stream<SystemGitStatus>, never, Scope.Scope>;
}>("t3/vcs/SystemGit", {
  // Without the layer every read probes again (a handful of stat calls); nothing is pushed.
  defaultValue: () => ({
    status: probe,
    refresh: probe,
    subscribeChanges: Effect.succeed(Stream.empty),
  }),
}) {}

/** The server's SystemGit: one cached answer, re-checked while git is missing. */
export const make = Effect.gen(function* () {
  const first = yield* probe;
  const current = yield* Ref.make(first);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<SystemGitStatus>(),
    PubSub.shutdown,
  );

  const refresh = Effect.gen(function* () {
    const next = yield* probe;
    const previous = yield* Ref.getAndSet(current, next);
    if (previous.available !== next.available || previous.path !== next.path) {
      yield* Effect.logInfo("System git changed", { available: next.available });
      yield* PubSub.publish(changesPubSub, next);
    }
    return next;
  }).pipe(Effect.withSpan("SystemGit.refresh"));

  const status = Ref.get(current).pipe(
    Effect.filterOrElse(
      (cached) => cached.available,
      () => refresh,
    ),
  );

  // Only while git is missing: a few stat calls every 5 s, never a process.
  yield* refresh.pipe(
    Effect.repeat({
      schedule: Schedule.spaced(MISSING_GIT_RECHECK_INTERVAL),
      until: (found) => found.available,
    }),
    Effect.delay(MISSING_GIT_RECHECK_INTERVAL),
    Effect.when(Effect.succeed(!first.available)),
    Effect.forkScoped,
  );

  return SystemGit.of({
    status,
    refresh,
    subscribeChanges: PubSub.subscribe(changesPubSub).pipe(Effect.map(Stream.fromSubscription)),
  });
});

export const layer = Layer.effect(SystemGit, make);

/** A fixed answer, for tests and hosts that must not probe. */
export const layerFixed = (status: SystemGitStatus) =>
  Layer.succeed(
    SystemGit,
    SystemGit.of({
      status: Effect.succeed(status),
      refresh: Effect.succeed(status),
      subscribeChanges: Effect.succeed(Stream.empty),
    }),
  );
