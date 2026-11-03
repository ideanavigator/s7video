import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  type ConnectionRegistration,
  ConnectionCredential,
  ConnectionProfile,
} from "../connection/catalog.ts";
import { type ConnectionTarget, PersistedConnectionTarget } from "../connection/model.ts";
import { StoredPullRequestRoutingPermission } from "../connection/pullRequestRoutingPermissions.ts";

export const StoredConnectionCredential = Schema.Struct({
  connectionId: Schema.String,
  credential: ConnectionCredential,
});
export type StoredConnectionCredential = typeof StoredConnectionCredential.Type;

const ConnectionCatalogFields = {
  schemaVersion: Schema.Literal(1),
  credentials: Schema.Array(StoredConnectionCredential),
  // Pull request routing grants. The field name predates the rename and stays, so older and
  // newer clients sharing this document keep reading and revoking the same grants.
  githubRoutingPermissions: Schema.optionalKey(Schema.Array(StoredPullRequestRoutingPermission)),
  disabledEnvironmentIds: Schema.Array(EnvironmentId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
};

const ConnectionCatalogDocumentType = Schema.Struct({
  ...ConnectionCatalogFields,
  targets: Schema.Array(PersistedConnectionTarget),
  profiles: Schema.Array(ConnectionProfile),
});

/**
 * Upstream T3 Code catalogs can hold T3 Connect routes and the `remoteDpopTokens`
 * they used. Their routes decode only to be dropped, and the tokens are never read.
 */
const LegacyRelayConnectionTarget = Schema.TaggedStruct("RelayConnectionTarget", {
  environmentId: EnvironmentId,
});
const LegacyT3ConnectProfile = Schema.TaggedStruct("BearerConnectionProfile", {
  connectionId: Schema.String,
  authorization: Schema.Literal("t3-connect"),
});

const StoredConnectionCatalogDocument = Schema.Struct({
  ...ConnectionCatalogFields,
  targets: Schema.Array(Schema.Union([PersistedConnectionTarget, LegacyRelayConnectionTarget])),
  // The legacy member goes first: a plain profile would otherwise accept it and drop `authorization`.
  profiles: Schema.Array(Schema.Union([LegacyT3ConnectProfile, ConnectionProfile])),
});

type ConnectionCatalogDocumentValue = typeof ConnectionCatalogDocumentType.Type;
type StoredConnectionCatalogDocumentValue = typeof StoredConnectionCatalogDocument.Type;

function dropLegacyCloudRecords(
  stored: StoredConnectionCatalogDocumentValue,
): ConnectionCatalogDocumentValue {
  const t3ConnectProfileIds = new Set(
    stored.profiles.flatMap((profile) =>
      "authorization" in profile ? [profile.connectionId] : [],
    ),
  );
  const targets = stored.targets.filter(
    (target): target is PersistedConnectionTarget =>
      target._tag !== "RelayConnectionTarget" && !t3ConnectProfileIds.has(target.connectionId),
  );
  const remaining = new Set(targets.map((target) => target.environmentId));
  const orphaned = new Set(
    stored.targets
      .map((target) => target.environmentId)
      .filter((environmentId) => !remaining.has(environmentId)),
  );
  return {
    schemaVersion: stored.schemaVersion,
    targets,
    profiles: stored.profiles.filter(
      (profile): profile is ConnectionProfile => !("authorization" in profile),
    ),
    credentials: stored.credentials,
    disabledEnvironmentIds: stored.disabledEnvironmentIds.filter((id) => !orphaned.has(id)),
    ...(stored.githubRoutingPermissions === undefined
      ? {}
      : {
          githubRoutingPermissions: stored.githubRoutingPermissions.filter(
            (permission) => !orphaned.has(permission.environmentId),
          ),
        }),
  };
}

export const ConnectionCatalogDocument = StoredConnectionCatalogDocument.pipe(
  Schema.decodeTo(
    Schema.toType(ConnectionCatalogDocumentType),
    SchemaTransformation.transform<
      ConnectionCatalogDocumentValue,
      StoredConnectionCatalogDocumentValue
    >({
      decode: dropLegacyCloudRecords,
      encode: (document) => document,
    }),
  ),
);
export type ConnectionCatalogDocument = typeof ConnectionCatalogDocument.Type;

export const EMPTY_CONNECTION_CATALOG_DOCUMENT: ConnectionCatalogDocument = Object.freeze({
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  disabledEnvironmentIds: [],
});

export function replaceCatalogValue<A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
  next: A,
): ReadonlyArray<A> {
  const nextKey = key(next);
  return [...values.filter((value) => key(value) !== nextKey), next];
}

export function removeCatalogValue<A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
  removedKey: string,
): ReadonlyArray<A> {
  return values.filter((value) => key(value) !== removedKey);
}

function connectionIdOf(target: ConnectionTarget): string | null {
  switch (target._tag) {
    case "PrimaryConnectionTarget":
      return null;
    case "BearerConnectionTarget":
    case "SshConnectionTarget":
      return target.connectionId;
  }
}

function routeKey(target: ConnectionTarget): string {
  return connectionIdOf(target) ?? target._tag;
}

function removeRouteMetadata(
  document: ConnectionCatalogDocument,
  removed: ReadonlyArray<ConnectionTarget>,
): ConnectionCatalogDocument {
  const connectionIds = new Set(removed.flatMap((target) => connectionIdOf(target) ?? []));
  return {
    ...document,
    profiles: document.profiles.filter((value) => !connectionIds.has(value.connectionId)),
    credentials: document.credentials.filter((value) => !connectionIds.has(value.connectionId)),
  };
}

export function catalogRoutes(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
): ReadonlyArray<PersistedConnectionTarget> {
  return document.targets.filter((target) => target.environmentId === environmentId);
}

/**
 * Records owned by a dropped route go with it; the environment keeps its
 * position in the catalog. An empty list leaves the environment's other records
 * in place; use `removeConnectionFromCatalog` to forget the environment.
 */
export function setRoutesInCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
  routes: ReadonlyArray<PersistedConnectionTarget>,
): ConnectionCatalogDocument {
  const kept = new Set(routes.map(routeKey));
  const dropped = catalogRoutes(document, environmentId).filter(
    (target) => !kept.has(routeKey(target)),
  );
  const firstIndex = document.targets.findIndex((target) => target.environmentId === environmentId);
  const others = document.targets.filter((target) => target.environmentId !== environmentId);
  const insertAt =
    firstIndex === -1
      ? others.length
      : document.targets.slice(0, firstIndex).filter((t) => t.environmentId !== environmentId)
          .length;
  return {
    ...removeRouteMetadata(document, dropped),
    targets: [...others.slice(0, insertAt), ...routes, ...others.slice(insertAt)],
  };
}

export function registerConnectionInCatalog(
  document: ConnectionCatalogDocument,
  registration: ConnectionRegistration,
  routes: ReadonlyArray<PersistedConnectionTarget> = [registration.target],
): ConnectionCatalogDocument {
  const next = setRoutesInCatalog(document, registration.target.environmentId, routes);

  return {
    ...next,
    profiles: replaceCatalogValue(
      next.profiles,
      (value) => value.connectionId,
      registration.profile,
    ),
    credentials: replaceCatalogValue(next.credentials, (value) => value.connectionId, {
      connectionId: registration.target.connectionId,
      credential: registration.credential,
    }),
  };
}

export function removeConnectionFromCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
): ConnectionCatalogDocument {
  const next = setRoutesInCatalog(document, environmentId, []);
  return {
    ...next,
    disabledEnvironmentIds: removeCatalogValue(
      next.disabledEnvironmentIds,
      (value) => value,
      environmentId,
    ),
    ...(next.githubRoutingPermissions === undefined
      ? {}
      : {
          githubRoutingPermissions: next.githubRoutingPermissions.filter(
            (permission) => permission.environmentId !== environmentId,
          ),
        }),
  };
}

export function setConnectionEnabledInCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
  enabled: boolean,
): ConnectionCatalogDocument {
  const registered = document.targets.some((target) => target.environmentId === environmentId);
  const without = removeCatalogValue(
    document.disabledEnvironmentIds,
    (value) => value,
    environmentId,
  );
  return {
    ...document,
    disabledEnvironmentIds: registered && !enabled ? [...without, environmentId] : without,
  };
}
