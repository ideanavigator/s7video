import { describe, expect, it } from "@effect/vitest";

import { presentConnectionDiagnosis } from "./diagnosis.ts";
import { credentialMissingError, mapRemoteEnvironmentError } from "./errors.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  type ConnectionAttemptError,
  type SupervisorConnectionState,
} from "./model.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";

const backoff = (lastFailure: ConnectionAttemptError): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "backoff",
  attempt: 3,
  lastFailure,
  retryAt: Date.UTC(2026, 9, 19, 12, 0, 30),
});

const unreachable = mapRemoteEnvironmentError(
  new RemoteEnvironmentAuthFetchError({ message: "Failed to fetch", cause: new TypeError() }),
);

const diagnose = (state: SupervisorConnectionState) =>
  presentConnectionDiagnosis({ hostLabel: "Mac mini", state });

const results = (state: SupervisorConnectionState) =>
  diagnose(state)?.hops.map((hop) => `${hop.hop}:${hop.result}`);

describe("presentConnectionDiagnosis", () => {
  it("returns nothing while no attempt has failed", () => {
    expect(diagnose(AVAILABLE_CONNECTION_STATE)).toBeNull();
  });

  it("blames s7video on the host when it cannot be reached", () => {
    expect(diagnose(backoff(unreachable))?.headline).toBe("s7video on Mac mini did not answer");
    expect(results(backoff(unreachable))).toEqual(["device:ok", "server:failed"]);
  });

  it("stops at this device when it could not prepare the connection", () => {
    const failure = credentialMissingError("bearer-1");
    expect(diagnose(backoff(failure))?.headline).toBe(
      "This device could not prepare the connection",
    );
    expect(results(backoff(failure))).toEqual(["device:failed", "server:unchecked"]);
  });

  it("reports this device as offline before any other hop", () => {
    const state = { ...backoff(unreachable), network: "offline" as const };
    expect(diagnose(state)?.headline).toBe("This device is offline");
    expect(results(state)?.[0]).toBe("device:failed");
  });

  it("asks to update a host that runs an older server", () => {
    const failure = new ConnectionBlockedError({
      reason: "unsupported",
      detail: "Update the host.",
      serverUpdateRequired: true,
    });
    expect(diagnose(backoff(failure))?.steps).toEqual(["Update s7video on Mac mini."]);
  });
});
