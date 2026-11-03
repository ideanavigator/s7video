import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "../connection/catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  SshConnectionTarget,
} from "../connection/model.ts";
import {
  PullRequestRoutingPermissions,
  makePullRequestRoutingPermissions,
} from "../connection/pullRequestRoutingPermissions.ts";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  catalogRoutes,
  setRoutesInCatalog,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
  setConnectionEnabledInCatalog,
} from "./storageDocument.ts";

const decodeConnectionCatalogDocument = Schema.decodeUnknownEffect(ConnectionCatalogDocument);

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const decodeCatalogDocument = Schema.decodeUnknownSync(ConnectionCatalogDocument);
const encodeCatalogDocumentJson = Schema.encodeSync(
  Schema.fromJsonString(ConnectionCatalogDocument),
);

const SSH_TARGET = new SshConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  connectionId: "ssh-1",
});
const SSH_PROFILE = new SshConnectionProfile({
  connectionId: SSH_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: SSH_TARGET.label,
  target: { alias: "work", hostname: "work.example.test", username: "maria", port: 22 },
});
const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  connectionId: "bearer-1",
});
const BEARER_PROFILE = new BearerConnectionProfile({
  connectionId: BEARER_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: BEARER_TARGET.label,
  httpBaseUrl: "https://remote.example.test",
  wsBaseUrl: "wss://remote.example.test",
});
const BEARER_CREDENTIAL = new BearerConnectionCredential({
  token: "bearer-token",
});
describe("ConnectionCatalogDocument", () => {
  it.effect("persists explicit GitHub trust and forgets it when a connection is removed", () =>
    Effect.gen(function* () {
      let document = EMPTY_CONNECTION_CATALOG_DOCUMENT;
      const entry = { target: BEARER_TARGET, profile: Option.some(BEARER_PROFILE), enabled: true };
      const storage = {
        read: Effect.sync(() => document.githubRoutingPermissions ?? []),
        write: (githubRoutingPermissions: NonNullable<typeof document.githubRoutingPermissions>) =>
          Effect.gen(function* () {
            document = yield* decodeConnectionCatalogDocument({
              ...document,
              githubRoutingPermissions,
            }).pipe(Effect.orDie);
          }),
      };
      const permissions = yield* makePullRequestRoutingPermissions(storage);
      expect(yield* permissions.get(entry)).toBe("off");
      yield* permissions.set(entry, "read");
      const restarted = yield* makePullRequestRoutingPermissions(storage);
      expect(yield* restarted.get(entry)).toBe("read");

      const changedEndpoint = {
        ...entry,
        profile: Option.some(
          new BearerConnectionProfile({
            ...BEARER_PROFILE,
            httpBaseUrl: "https://different.example.test",
          }),
        ),
      };
      expect(yield* restarted.get(changedEndpoint)).toBe("off");
      expect(
        yield* restarted.get({
          ...entry,
          profile: Option.some(
            new BearerConnectionProfile({
              ...BEARER_PROFILE,
              wsBaseUrl: "wss://different.example.test",
            }),
          ),
        }),
      ).toBe("off");
      expect(
        yield* restarted.get({
          target: SSH_TARGET,
          profile: Option.some(SSH_PROFILE),
          enabled: true,
        }),
      ).toBe("off");
      yield* restarted.set(entry, "read-write");
      expect(yield* restarted.get(entry)).toBe("read-write");
      yield* restarted.forget(ENVIRONMENT_ID);
      expect(yield* restarted.get(entry)).toBe("off");
      const afterRemoval = yield* makePullRequestRoutingPermissions(storage);
      expect(yield* afterRemoval.get(entry)).toBe("off");

      yield* permissions.set(entry, "read");
      document = removeConnectionFromCatalog(document, ENVIRONMENT_ID);
      const afterCatalogRemoval = yield* makePullRequestRoutingPermissions(storage);
      expect(yield* afterCatalogRemoval.get(entry)).toBe("off");
    }),
  );

  it.effect("requires explicit trust for primary, bearer, and SSH connections independently", () =>
    Effect.gen(function* () {
      const permissions = yield* makePullRequestRoutingPermissions({
        read: Effect.succeed([]),
        write: () => Effect.void,
      });
      const entries = [
        {
          target: new PrimaryConnectionTarget({
            environmentId: ENVIRONMENT_ID,
            label: "Local",
            httpBaseUrl: "http://localhost:3000",
            wsBaseUrl: "ws://localhost:3000",
          }),
          profile: Option.none(),
          enabled: true,
        },
        { target: BEARER_TARGET, profile: Option.some(BEARER_PROFILE), enabled: true },
        {
          enabled: true,
          target: new SshConnectionTarget({
            environmentId: ENVIRONMENT_ID,
            label: "SSH",
            connectionId: "ssh-1",
          }),
          profile: Option.some(
            new SshConnectionProfile({
              environmentId: ENVIRONMENT_ID,
              label: "SSH",
              connectionId: "ssh-1",
              target: { alias: "work", hostname: "work.example.test", username: "maria", port: 22 },
            }),
          ),
        },
      ];
      for (const entry of entries) {
        expect(yield* permissions.get(entry)).toBe("off");
        yield* permissions.set(entry, "read");
        expect(yield* permissions.get(entry)).toBe("read");
        yield* permissions.set(entry, "off");
        expect(yield* permissions.get(entry)).toBe("off");
      }
    }),
  );

  it.effect("does not enable GitHub routing when permission persistence fails", () =>
    Effect.gen(function* () {
      const entry = { target: BEARER_TARGET, profile: Option.some(BEARER_PROFILE), enabled: true };
      expect(yield* (yield* PullRequestRoutingPermissions).get(entry)).toBe("off");
      const permissions = yield* makePullRequestRoutingPermissions({
        read: Effect.succeed([]),
        write: () =>
          Effect.fail(
            new ConnectionTransientError({
              reason: "remote-unavailable",
              detail: "storage unavailable",
            }),
          ),
      });
      yield* permissions.set(entry, "read-write").pipe(Effect.flip);
      expect(yield* permissions.get(entry)).toBe("off");
    }),
  );

  it("removes every catalog record owned by an explicit disconnect", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    expect(removeConnectionFromCatalog(registered, ENVIRONMENT_ID)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });

  it("decodes a document written before the disabled list existed", () => {
    const decoded = decodeCatalogDocument({
      schemaVersion: 1,
      targets: [],
      profiles: [],
      credentials: [],
    });

    expect(decoded.disabledEnvironmentIds).toEqual([]);
  });

  it("drops T3 Connect routes and their tokens from an upstream T3 Code catalog", () => {
    const relayOnlyId = EnvironmentId.make("environment-relay-only");
    const upstream = {
      schemaVersion: 1,
      targets: [
        {
          _tag: "BearerConnectionTarget",
          environmentId: ENVIRONMENT_ID,
          label: "Remote",
          connectionId: "bearer-1",
        },
        { _tag: "RelayConnectionTarget", environmentId: ENVIRONMENT_ID, label: "Remote" },
        {
          _tag: "BearerConnectionTarget",
          environmentId: ENVIRONMENT_ID,
          label: "Remote",
          connectionId: "learned:environment-1:http://192.168.1.10:3773",
        },
        {
          _tag: "SshConnectionTarget",
          environmentId: ENVIRONMENT_ID,
          label: "Remote",
          connectionId: "ssh-1",
        },
        { _tag: "RelayConnectionTarget", environmentId: relayOnlyId, label: "Connect only" },
      ],
      profiles: [
        {
          _tag: "BearerConnectionProfile",
          connectionId: "bearer-1",
          environmentId: ENVIRONMENT_ID,
          label: "Remote",
          httpBaseUrl: "https://remote.example.test",
          wsBaseUrl: "wss://remote.example.test",
        },
        {
          _tag: "BearerConnectionProfile",
          connectionId: "learned:environment-1:http://192.168.1.10:3773",
          environmentId: ENVIRONMENT_ID,
          label: "Remote",
          httpBaseUrl: "http://192.168.1.10:3773/",
          wsBaseUrl: "ws://192.168.1.10:3773/",
          learned: true,
          authorization: "t3-connect",
        },
        {
          _tag: "SshConnectionProfile",
          connectionId: "ssh-1",
          environmentId: ENVIRONMENT_ID,
          label: "Remote",
          target: { alias: "work", hostname: "work.example.test", username: "maria", port: 22 },
        },
      ],
      credentials: [
        {
          connectionId: "bearer-1",
          credential: { _tag: "BearerConnectionCredential", token: "bearer-token" },
        },
      ],
      remoteDpopTokens: [
        {
          environmentId: ENVIRONMENT_ID,
          accountId: "user_1",
          label: "Remote",
          endpoint: {
            httpBaseUrl: "https://environment-1.t3.codes",
            wsBaseUrl: "wss://environment-1.t3.codes",
            providerKind: "cloudflare_tunnel",
          },
          accessToken: "stale-dpop-access-token",
          expiresAtEpochMs: 1_000_000,
          dpopThumbprint: "stale-thumbprint",
        },
      ],
      githubRoutingPermissions: [
        { environmentId: ENVIRONMENT_ID, connectionKey: "bearer", permission: "read" },
        { environmentId: relayOnlyId, connectionKey: "relay", permission: "read" },
      ],
      disabledEnvironmentIds: [relayOnlyId],
    };

    const decoded = decodeCatalogDocument(upstream);

    expect(decoded.targets).toEqual([BEARER_TARGET, SSH_TARGET]);
    expect(decoded.profiles).toEqual([BEARER_PROFILE, SSH_PROFILE]);
    expect(decoded.targets[0]).toBeInstanceOf(BearerConnectionTarget);
    expect(decoded.profiles[0]).toBeInstanceOf(BearerConnectionProfile);
    expect(decoded.profiles[1]).toBeInstanceOf(SshConnectionProfile);
    expect(decoded.credentials).toEqual([
      { connectionId: BEARER_TARGET.connectionId, credential: BEARER_CREDENTIAL },
    ]);
    expect(decoded.disabledEnvironmentIds).toEqual([]);
    expect(decoded.githubRoutingPermissions).toEqual([
      { environmentId: ENVIRONMENT_ID, connectionKey: "bearer", permission: "read" },
    ]);
    const reencoded = encodeCatalogDocumentJson(decoded);
    expect(reencoded).not.toContain("remoteDpopTokens");
    expect(reencoded).not.toContain("stale-dpop-access-token");
    expect(reencoded).not.toContain("stale-thumbprint");
    expect(reencoded).not.toContain("RelayConnectionTarget");
    expect(reencoded).not.toContain("t3-connect");
    expect(decodeCatalogDocument(JSON.parse(reencoded))).toEqual(decoded);
  });

  it("switches a saved environment off and back on without touching its records", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    const disabled = setConnectionEnabledInCatalog(registered, ENVIRONMENT_ID, false);
    expect(disabled.disabledEnvironmentIds).toEqual([ENVIRONMENT_ID]);
    expect(disabled.targets).toEqual(registered.targets);
    expect(disabled.credentials).toEqual(registered.credentials);
    expect(
      setConnectionEnabledInCatalog(disabled, ENVIRONMENT_ID, false).disabledEnvironmentIds,
    ).toEqual([ENVIRONMENT_ID]);

    expect(
      setConnectionEnabledInCatalog(disabled, ENVIRONMENT_ID, true).disabledEnvironmentIds,
    ).toEqual([]);
    expect(
      registerConnectionInCatalog(
        disabled,
        new BearerConnectionRegistration({
          target: BEARER_TARGET,
          profile: BEARER_PROFILE,
          credential: BEARER_CREDENTIAL,
        }),
      ).disabledEnvironmentIds,
    ).toEqual([ENVIRONMENT_ID]);
    expect(removeConnectionFromCatalog(disabled, ENVIRONMENT_ID).disabledEnvironmentIds).toEqual(
      [],
    );
  });

  it("persists the normalized SSH profile and its paired token beside its target", () => {
    const target = new SshConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "SSH",
      connectionId: "ssh-1",
    });
    const profile = new SshConnectionProfile({
      connectionId: target.connectionId,
      environmentId: target.environmentId,
      label: target.label,
      target: {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      },
    });
    const document = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new SshConnectionRegistration({ target, profile, credential: BEARER_CREDENTIAL }),
    );

    expect(document.targets).toEqual([target]);
    expect(document.profiles).toEqual([profile]);
    expect(document.credentials).toEqual([
      { connectionId: target.connectionId, credential: BEARER_CREDENTIAL },
    ]);
    // Removing the route forgets its token too.
    expect(removeConnectionFromCatalog(document, ENVIRONMENT_ID).credentials).toEqual([]);
  });

  it("keeps every route of an environment and drops only a removed route's records", () => {
    const withBearer = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const withSsh = registerConnectionInCatalog(
      withBearer,
      new SshConnectionRegistration({
        target: SSH_TARGET,
        profile: SSH_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
      [BEARER_TARGET, SSH_TARGET],
    );
    expect(catalogRoutes(withSsh, ENVIRONMENT_ID)).toEqual([BEARER_TARGET, SSH_TARGET]);
    expect(withSsh.credentials).toHaveLength(2);

    const sshOnly = setRoutesInCatalog(withSsh, ENVIRONMENT_ID, [SSH_TARGET]);
    expect(sshOnly.targets).toEqual([SSH_TARGET]);
    expect(sshOnly.profiles).toEqual([SSH_PROFILE]);
    expect(sshOnly.credentials.map((value) => value.connectionId)).toEqual([
      SSH_TARGET.connectionId,
    ]);

    const bearerOnly = setRoutesInCatalog(withSsh, ENVIRONMENT_ID, [BEARER_TARGET]);
    expect(bearerOnly.profiles).toEqual([BEARER_PROFILE]);
    expect(bearerOnly.credentials.map((value) => value.connectionId)).toEqual([
      BEARER_TARGET.connectionId,
    ]);
  });

  it("keeps an environment's position in the catalog when its routes change", () => {
    const other = new BearerConnectionTarget({
      environmentId: EnvironmentId.make("environment-2"),
      label: "Other",
      connectionId: "bearer-2",
    });
    const document = {
      ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
      targets: [SSH_TARGET, other],
    };
    expect(
      setRoutesInCatalog(document, ENVIRONMENT_ID, [BEARER_TARGET, SSH_TARGET]).targets,
    ).toEqual([BEARER_TARGET, SSH_TARGET, other]);
  });
});
