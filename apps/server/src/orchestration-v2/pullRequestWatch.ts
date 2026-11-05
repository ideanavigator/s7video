import type {
  PullRequestCheck,
  PullRequestComment,
  PullRequestDetail,
  ThreadPullRequestWatch,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Bounds consecutive comment-only wakes to stop bot reply loops; check, conflict, or push news resets it. */
export const PULL_REQUEST_WATCH_WAKE_LIMIT = 10;
/** How long a head may go without any check before the agent is told none reported. */
const PULL_REQUEST_WATCH_NO_CHECKS_MS = 15 * 60_000;

export type PullRequestWatchChange =
  | { readonly kind: "checks-failed"; readonly failed: ReadonlyArray<PullRequestCheck> }
  | { readonly kind: "checks-passed"; readonly count: number; readonly required: boolean }
  | { readonly kind: "remarks"; readonly remarks: ReadonlyArray<PullRequestComment> }
  | { readonly kind: "no-checks"; readonly minutes: number }
  | { readonly kind: "conflicting" };

export interface PullRequestWatchReport {
  readonly changes: ReadonlyArray<PullRequestWatchChange>;
  readonly next: ThreadPullRequestWatch;
  readonly exhausted: boolean;
}

// action-required is a finished check needing human input.
const isFailedCheck = (check: PullRequestCheck) =>
  check.status === "failure" || check.status === "cancelled" || check.status === "action-required";

export function evaluatePullRequestWatch(
  watch: ThreadPullRequestWatch,
  detail: Pick<
    PullRequestDetail,
    "capabilities" | "headSha" | "checks" | "mergeability" | "viewer" | "author"
  >,
  remarks: ReadonlyArray<PullRequestComment> | null,
  now: number,
): PullRequestWatchReport {
  const changes: Array<PullRequestWatchChange> = [];
  const headSha = detail.headSha ?? null;
  const headMoved = headSha !== watch.headSha;

  // Hosts can return no checks on read failure; preserve prior state.
  let failedChecks = headMoved ? [] : watch.failedChecks;
  let passed = headMoved ? false : watch.passed;
  let passedChecks = headMoved ? [] : watch.passedChecks;
  let owedChecks = headMoved ? [] : (watch.owedChecks ?? []);
  if (detail.checks.length > 0) {
    const failed = detail.checks.filter(isFailedCheck);
    const newlyFailed = failed.filter((check) => !failedChecks.includes(check.name));
    if (newlyFailed.length > 0) changes.push({ kind: "checks-failed", failed: newlyFailed });
    failedChecks = failed.map((check) => check.name);

    const required = detail.checks.filter((check) => check.required === true);
    const gate = required.length > 0 ? required : detail.checks;
    const passedNow = gate.every((check) => check.status !== "pending" && !isFailedCheck(check));
    const gateNames = gate.map((check) => check.name);
    const told = passed && passedChecks.length === 0 ? gateNames : passedChecks;
    // Required checks can finish between sweeps; detect new names. With no required checks, ignore advisory gate growth.
    const gateGrew = required.length > 0 && gateNames.some((name) => !told.includes(name));
    // Other checks still pending when required ones passed are owed one wake when all settle.
    // Only those are owed, so later advisory churn never wakes. One turned required is gate news.
    const owed =
      passedNow && passed
        ? detail.checks
            .filter((check) => check.required !== true && owedChecks.includes(check.name))
            .map((check) => check.name)
        : [];
    const settled =
      failed.length === 0 && detail.checks.every((check) => check.status !== "pending");
    owedChecks = owed;
    if (passedNow && (!passed || gateGrew)) {
      changes.push({ kind: "checks-passed", count: gate.length, required: required.length > 0 });
      owedChecks =
        required.length > 0
          ? detail.checks
              .filter((check) => check.required !== true && check.status === "pending")
              .map((check) => check.name)
          : [];
    } else if (settled && owed.length > 0) {
      changes.push({ kind: "checks-passed", count: detail.checks.length, required: false });
      owedChecks = [];
    }
    passed = passedNow;
    passedChecks = passedNow ? gateNames : [];
  }

  // Only a head never read with checks waits for them: an empty read after checks were seen is
  // the failed read above. A watch saved before this field may have seen pending checks on its
  // head, so its clock starts only at the next push. Where a host's empty list can mean the
  // repository runs no checks at all, nothing waits.
  let checksAwaitedSince = watch.checksAwaitedSince;
  if (detail.capabilities.checksAlwaysReport === true) {
    const awaitedBefore = headMoved
      ? DateTime.formatIso(DateTime.makeUnsafe(now))
      : (watch.checksAwaitedSince ?? null);
    checksAwaitedSince = detail.checks.length > 0 ? null : awaitedBefore;
    const awaitedMs = checksAwaitedSince === null ? 0 : now - Date.parse(checksAwaitedSince);
    if (awaitedMs >= PULL_REQUEST_WATCH_NO_CHECKS_MS) {
      changes.push({ kind: "no-checks", minutes: Math.round(awaitedMs / 60_000) });
      checksAwaitedSince = null;
    }
  }

  const own = (detail.viewer ?? detail.author?.login)?.toLowerCase();
  const through = Date.parse(watch.remarksThrough);
  const activeAt = (remark: PullRequestComment) => remark.editedAt ?? remark.createdAt;
  // Hosts can stamp remarks to the second, so remarks at the boundary time are told apart by ID.
  const fresh = (remarks ?? []).filter((remark) => {
    const at = Date.parse(activeAt(remark));
    return (
      (at > through || (at === through && !watch.remarkIds.includes(remark.id))) &&
      remark.author?.login.toLowerCase() !== own
    );
  });
  if (fresh.length > 0) changes.push({ kind: "remarks", remarks: fresh });
  const latest = Math.max(through, ...fresh.map((remark) => Date.parse(activeAt(remark))));
  const atLatest = fresh.filter((remark) => Date.parse(activeAt(remark)) === latest);
  const remarksThrough = latest === through ? watch.remarksThrough : activeAt(atLatest[0]!);
  const remarkIds = [
    ...(latest === through ? watch.remarkIds : []),
    ...atLatest.map((remark) => remark.id),
  ];

  if (detail.mergeability === "conflicting" && !watch.conflicting) {
    changes.push({ kind: "conflicting" });
  }
  // "unknown" is a host still computing after a push; only a clean answer clears a conflict.
  const conflicting =
    detail.mergeability === "unknown" ? watch.conflicting : detail.mergeability === "conflicting";

  const commentsOnly = changes.length > 0 && changes.every((change) => change.kind === "remarks");
  const progress = headMoved || (changes.length > 0 && !commentsOnly);
  const wakes = (progress ? 0 : watch.wakes) + (commentsOnly ? 1 : 0);
  return {
    changes,
    next: {
      startedAt: watch.startedAt,
      headSha,
      failedChecks,
      passed,
      passedChecks,
      owedChecks,
      remarksThrough,
      remarkIds,
      conflicting,
      wakes,
      checksAwaitedSince,
    },
    exhausted: commentsOnly && wakes >= PULL_REQUEST_WATCH_WAKE_LIMIT,
  };
}
