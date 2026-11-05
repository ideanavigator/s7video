import { BRAND } from "@t3tools/shared/brand";
import { SessionPermissions } from "./SessionPermissions";
import { ChevronRightIcon, EllipsisIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  type AuthClientSession,
  type AuthPairingLink,
  type AuthPairingCredentialResult,
  type AdvertisedEndpoint,
  type DesktopServerExposureState,
  type EnvironmentId,
  managedCapabilityDenial,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";

import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { resolveLocalVersionStatusLabel } from "./ConnectionsSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { ManagedByOrganization } from "../ManagedPolicy";
import { LocalEnvironmentSetting } from "./LocalEnvironmentSetting";
import { searchableSetting } from "./settingsSearch";
import { EnvironmentIconMenu } from "./EnvironmentIconPicker";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { LinkedEnvironmentsSettings } from "./LinkedEnvironmentsSettings";
import { usePeerLinkHosts } from "~/state/peerLinks";
import { LoadBalancingSettings } from "./LoadBalancingSettings";
import { ScrollArea } from "../ui/scroll-area";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Spinner } from "../ui/spinner";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  usePrimarySessionState,
  type ServerClientSessionRecord,
} from "~/environments/primary";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { useUiStateStore } from "~/uiStateStore";
import {
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
} from "~/versionSkew";
import { authEnvironment } from "~/state/auth";
import { environmentCatalog } from "~/connection/catalog";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useEnvironmentQuery } from "~/state/query";
import {
  desktopNetworkAccessStateAtom,
  refreshDesktopNetworkAccessState,
} from "~/state/desktopNetworkAccess";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironment,
} from "~/state/environments";
import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "../../state/use-atom-command";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { environmentUpdateStatesAtom, serverEnvironment } from "~/state/server";
import {
  ServerUpdateAction,
  ServerUpdateProgress,
  ServerUpdatesAction,
  type ServerUpdateTarget,
} from "../ServerUpdateAction";
import {
  sortDesktopPairingLinks,
  summarizeAuthorizedClients,
  sortDesktopClientSessions,
  toDesktopPairingLinkRecord,
  toDesktopClientSessionRecord,
  selectPairingEndpoint,
  endpointDefaultPreferenceKey,
} from "./ConnectionsSettings.logic";
import {
  AdvertisedEndpointListRow,
  AuthorizedClientsHeaderAction,
  NetworkAccessDescription,
  PairingClientsList,
} from "./AuthorizedClientsSettings";
import { ITEM_ROW_CLASSNAME } from "./itemRows";
import { EmptyRemoteEnvironments, SavedBackendListRow } from "./SavedEnvironmentRows";
import { AddEnvironmentDialog } from "./AddEnvironmentDialog";

const EMPTY_ADVERTISED_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];

// Subscribes on its own so desktop download progress does not re-render the page.
function LocalVersionStatusLabel() {
  const updateState = useDesktopUpdateState();
  return (
    <span className="text-xs text-muted-foreground">
      {resolveLocalVersionStatusLabel(updateState)}
    </span>
  );
}

/** Environments lists the machines this app connects to; access covers who may reach this one. */
export function ConnectionsSettings({ view }: { readonly view: "environments" | "access" }) {
  const desktopBridge = window.desktopBridge;
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const peerLinkHosts = usePeerLinkHosts();
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const setEnvironmentEnabled = useAtomCommand(environmentCatalog.setEnabled, {
    reportFailure: false,
  });
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const primarySessionState = usePrimarySessionState();
  const currentSessionScopes = primarySessionState.data?.authenticated
    ? (primarySessionState.data.permissions ?? primarySessionState.data.scopes ?? null)
    : null;
  const currentAuthPolicy = desktopBridge ? null : (primarySessionState.data?.auth.policy ?? null);
  const savedEnvironments = environments.filter(
    (environment) => environment.entry.target._tag !== "PrimaryConnectionTarget",
  );
  const listedEnvironments = savedEnvironments.filter(
    (environment) => !isDesktopLocalConnectionTarget(environment.entry.target),
  );
  const savedUpdateStates = useAtomValue(
    environmentUpdateStatesAtom(
      environmentIdsKey(savedEnvironments.map(({ environmentId }) => environmentId)),
    ),
  );
  const savedServerUpdateStates = savedEnvironments.map((environment, index) => ({
    environment,
    updateStatus: savedUpdateStates[index]!.status,
  }));
  const savedServerUpdateTargets = savedServerUpdateStates.flatMap(
    ({ environment, updateStatus }): ServerUpdateTarget[] => {
      const mismatch = resolveServerConfigVersionMismatch(environment.serverConfig);
      const selfUpdate = resolveServerSelfUpdateCapability(environment.serverConfig);
      const desktopAppUpdate = supportsDesktopAppUpdate(environment.serverConfig);
      if (
        !mismatch ||
        updateStatus === "running" ||
        !environment.entry.enabled ||
        environment.connection.phase !== "connected" ||
        isDesktopLocalConnectionTarget(environment.entry.target) ||
        selfUpdate === null ||
        (selfUpdate === "desktop-managed" && !desktopAppUpdate)
      ) {
        return [];
      }
      return [
        {
          environmentId: environment.environmentId,
          serverLabel: environment.label,
          selfUpdate,
          installation: environment.serverConfig?.environment.capabilities.serverInstallation,
          desktopAppUpdate,
          targetVersion: mismatch.clientVersion,
        },
      ];
    },
  );
  const loadBalancingEnvironments = [
    ...(primaryEnvironment ? [primaryEnvironment] : []),
    ...savedEnvironments.filter((environment) => environment.entry.enabled),
  ].filter((environment) => environment.connection.phase !== "unsupported");
  const [desktopServerExposureMutationError, setDesktopServerExposureMutationError] = useState<
    string | null
  >(null);
  const [desktopAccessManagementMutationError, setDesktopAccessManagementMutationError] = useState<
    string | null
  >(null);
  const [createdPairingCredentials, setCreatedPairingCredentials] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const handlePairingLinkCreated = (created: AuthPairingCredentialResult) => {
    setCreatedPairingCredentials((current) => new Map(current).set(created.id, created.credential));
  };
  const [revokingDesktopPairingLinkId, setRevokingDesktopPairingLinkId] = useState<string | null>(
    null,
  );
  const [revokingDesktopClientSessionId, setRevokingDesktopClientSessionId] = useState<
    string | null
  >(null);
  const [isRevokingOtherDesktopClients, setIsRevokingOtherDesktopClients] = useState(false);
  const [addBackendDialogOpen, setAddBackendDialogOpen] = useState(false);
  const [routeTarget, setRouteTarget] = useState<EnvironmentPresentation | null>(null);
  const [savedBackendError, setSavedBackendError] = useState<string | null>(null);
  const handleAddBackendDialogOpenChange = (open: boolean) => {
    setAddBackendDialogOpen(open);
    if (open) {
      setRouteTarget(null);
    } else {
      setSavedBackendError(null);
    }
  };
  const [removingSavedEnvironmentId, setRemovingSavedEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const [isUpdatingDesktopServerExposure, setIsUpdatingDesktopServerExposure] = useState(false);
  const [pendingDesktopServerExposureMode, setPendingDesktopServerExposureMode] = useState<
    DesktopServerExposureState["mode"] | null
  >(null);
  const primaryServerConfig = primaryEnvironment?.serverConfig ?? null;
  const primaryManagedPolicy = primaryServerConfig?.managedPolicy;
  // Turning remote access off stays possible; only the way in is managed.
  const remoteClientsDenial = managedCapabilityDenial(primaryManagedPolicy, "remoteClients");
  const primaryVersionMismatch = resolveServerConfigVersionMismatch(primaryServerConfig);
  const primaryServerUpdateState = useAtomValue(
    serverEnvironment.updateStateAtom(primaryEnvironmentId),
  );
  const [isAdvertisedEndpointListExpanded, setIsAdvertisedEndpointListExpanded] = useState(false);
  const defaultAdvertisedEndpointKey = useUiStateStore(
    (state) => state.defaultAdvertisedEndpointKey,
  );
  const setDefaultAdvertisedEndpointKey = useUiStateStore(
    (state) => state.setDefaultAdvertisedEndpointKey,
  );
  const canReadAccess = useEnvironmentScope(primaryEnvironmentId, AuthAccessReadScope);
  const canWriteAccess = useEnvironmentScope(primaryEnvironmentId, AuthAccessWriteScope);
  const canMaintain = useEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope);
  const canManageLocalBackend = !isLocalEnvironmentDisabled() && canMaintain;
  const showsAccess = view === "access";
  const authAccessChanges = useEnvironmentQuery(
    showsAccess && canReadAccess && primaryEnvironmentId !== null
      ? authEnvironment.accessChanges({
          environmentId: primaryEnvironmentId,
          input: null,
        })
      : null,
  );
  const desktopNetworkAccess = useEnvironmentQuery(
    showsAccess && canManageLocalBackend && desktopBridge ? desktopNetworkAccessStateAtom : null,
  );
  const desktopServerExposureState = desktopNetworkAccess.data?.serverExposureState ?? null;
  const desktopAdvertisedEndpoints =
    desktopNetworkAccess.data?.advertisedEndpoints ?? EMPTY_ADVERTISED_ENDPOINTS;
  const desktopServerExposureError =
    desktopServerExposureMutationError ?? desktopNetworkAccess.error;
  const desktopAccessManagementError =
    desktopAccessManagementMutationError ?? authAccessChanges.error;
  const isLoadingDesktopAccessManagement =
    authAccessChanges.isPending && authAccessChanges.data === null;
  const desktopPairingLinks = (() => {
    const event = authAccessChanges.data;
    if (event?.type !== "snapshot") return [];
    return sortDesktopPairingLinks(
      event.payload.pairingLinks.map((pairingLink: AuthPairingLink) =>
        toDesktopPairingLinkRecord(pairingLink),
      ),
    );
  })();
  const desktopClientSessions = (() => {
    const event = authAccessChanges.data;
    if (event?.type !== "snapshot") return [];
    return sortDesktopClientSessions(
      event.payload.clientSessions.map((clientSession: AuthClientSession) =>
        toDesktopClientSessionRecord(clientSession),
      ),
    );
  })();
  const isLocalBackendNetworkAccessible = desktopBridge
    ? desktopServerExposureState?.mode === "network-accessible"
    : currentAuthPolicy === "remote-reachable";
  const handleDesktopServerExposureChange = async (checked: boolean) => {
    if (
      !desktopBridge ||
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope)
    )
      return;
    setIsUpdatingDesktopServerExposure(true);
    setDesktopServerExposureMutationError(null);
    try {
      await desktopBridge.setServerExposureMode(checked ? "network-accessible" : "local-only");
      refreshDesktopNetworkAccessState();
      setPendingDesktopServerExposureMode(null);
      setIsUpdatingDesktopServerExposure(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update network exposure.";
      setPendingDesktopServerExposureMode(null);
      setDesktopServerExposureMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update network access",
          description: message,
        }),
      );
      setIsUpdatingDesktopServerExposure(false);
    }
  };

  const handleConfirmDesktopServerExposureChange = () => {
    if (pendingDesktopServerExposureMode === null) return;
    const checked = pendingDesktopServerExposureMode === "network-accessible";
    void handleDesktopServerExposureChange(checked);
  };

  const handleRevokeDesktopPairingLink = async (id: string) => {
    if (
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthAccessWriteScope)
    )
      return;
    setRevokingDesktopPairingLinkId(id);
    setDesktopAccessManagementMutationError(null);
    const settled = await settlePromise(async () => {
      await revokeServerPairingLink(id);
    });
    if (settled._tag === "Failure") {
      const error = Cause.squash(settled.cause);
      const message = error instanceof Error ? error.message : "Failed to revoke pairing link.";
      setDesktopAccessManagementMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not revoke pairing link",
          description: message,
        }),
      );
    }
    setRevokingDesktopPairingLinkId(null);
  };

  const handleRevokeDesktopClientSession = async (
    sessionId: ServerClientSessionRecord["sessionId"],
  ) => {
    if (
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthAccessWriteScope)
    )
      return;
    setRevokingDesktopClientSessionId(sessionId);
    setDesktopAccessManagementMutationError(null);
    const settled = await settlePromise(async () => {
      await revokeServerClientSession(sessionId);
    });
    if (settled._tag === "Failure") {
      const error = Cause.squash(settled.cause);
      const message = error instanceof Error ? error.message : "Failed to revoke client access.";
      setDesktopAccessManagementMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not revoke client access",
          description: message,
        }),
      );
    }
    setRevokingDesktopClientSessionId(null);
  };

  const handleRevokeOtherDesktopClients = async () => {
    if (
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthAccessWriteScope)
    )
      return;
    setIsRevokingOtherDesktopClients(true);
    setDesktopAccessManagementMutationError(null);
    const settled = await settlePromise(async () => {
      const revokedCount = await revokeOtherServerClientSessions();
      toastManager.add({
        type: "success",
        title: revokedCount === 1 ? "Revoked 1 other client" : `Revoked ${revokedCount} clients`,
        description: "Other paired clients will need a new pairing link before reconnecting.",
      });
    });
    if (settled._tag === "Failure") {
      const error = Cause.squash(settled.cause);
      const message = error instanceof Error ? error.message : "Failed to revoke other clients.";
      setDesktopAccessManagementMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not revoke other clients",
          description: message,
        }),
      );
    }
    setIsRevokingOtherDesktopClients(false);
  };

  const handleSetSavedBackendEnabled = async (environmentId: EnvironmentId, enabled: boolean) => {
    setSavedBackendError(null);
    const result = await setEnvironmentEnabled({ environmentId, enabled });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const message =
        error instanceof Error
          ? error.message
          : `Failed to switch the backend ${enabled ? "on" : "off"}.`;
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not switch backend ${enabled ? "on" : "off"}`,
          description: message,
        }),
      );
    }
  };

  const removeSavedBackend = async (environment: EnvironmentPresentation) => {
    const environmentId = environment.environmentId;
    setRemovingSavedEnvironmentId(environmentId);
    setSavedBackendError(null);
    const result = await removeEnvironment(environmentId);
    setRemovingSavedEnvironmentId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const message = error instanceof Error ? error.message : "Failed to remove backend.";
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not remove backend",
          description: message,
        }),
      );
    }
  };

  const handleRemoveSavedBackend = async (environment: EnvironmentPresentation) => {
    const confirmed = await requestConfirmDialog(
      `Remove ${environment.label} from this device?\nThis forgets its pairing, credentials, and cached threads here. Switch it off instead to keep it saved.`,
      { variant: "destructive" },
    );
    if (confirmed === true) await removeSavedBackend(environment);
  };

  const visibleDesktopPairingLinks = desktopPairingLinks;
  const visibleDesktopNetworkAdvertisedEndpoints = isLocalBackendNetworkAccessible
    ? desktopAdvertisedEndpoints
    : [];
  const visibleDesktopAdvertisedEndpoints = visibleDesktopNetworkAdvertisedEndpoints;
  const defaultDesktopNetworkAdvertisedEndpoint = selectPairingEndpoint(
    visibleDesktopNetworkAdvertisedEndpoints,
    defaultAdvertisedEndpointKey,
  );
  const defaultDesktopAdvertisedEndpoint = defaultDesktopNetworkAdvertisedEndpoint;
  const defaultDesktopAdvertisedEndpointKey = defaultDesktopAdvertisedEndpoint
    ? endpointDefaultPreferenceKey(defaultDesktopAdvertisedEndpoint)
    : null;
  const handleSetDefaultAdvertisedEndpoint = (endpoint: AdvertisedEndpoint) => {
    setDefaultAdvertisedEndpointKey(endpointDefaultPreferenceKey(endpoint));
  };

  const renderNetworkAccessToggle = () => (
    <Switch
      checked={desktopServerExposureState?.mode === "network-accessible"}
      disabled={!desktopServerExposureState || isUpdatingDesktopServerExposure}
      onCheckedChange={(checked) => {
        setPendingDesktopServerExposureMode(checked ? "network-accessible" : "local-only");
      }}
      aria-label="Enable network access"
    />
  );
  const renderEndpointRows = () =>
    isAdvertisedEndpointListExpanded
      ? visibleDesktopNetworkAdvertisedEndpoints.map((endpoint) => {
          const endpointKey = endpointDefaultPreferenceKey(endpoint);
          return (
            <AdvertisedEndpointListRow
              key={endpoint.id}
              endpoint={endpoint}
              isDefault={endpointKey === defaultDesktopAdvertisedEndpointKey}
              onSetDefault={handleSetDefaultAdvertisedEndpoint}
            />
          );
        })
      : null;
  const renderAuthorizedClients = () => (
    <>
      {desktopAccessManagementError ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-xs text-destructive">{desktopAccessManagementError}</p>
        </div>
      ) : null}
      <PairingClientsList
        endpointUrl={desktopServerExposureState?.endpointUrl}
        endpoints={visibleDesktopAdvertisedEndpoints}
        defaultEndpointKey={defaultDesktopAdvertisedEndpointKey}
        isLoading={isLoadingDesktopAccessManagement}
        pairingLinks={visibleDesktopPairingLinks}
        createdPairingCredentials={createdPairingCredentials}
        clientSessions={desktopClientSessions}
        revokingPairingLinkId={revokingDesktopPairingLinkId}
        revokingClientSessionId={revokingDesktopClientSessionId}
        onRevokePairingLink={handleRevokeDesktopPairingLink}
        onRevokeClientSession={handleRevokeDesktopClientSession}
        canRevoke={canWriteAccess}
      />
    </>
  );
  const renderNetworkAccessRow = () => (
    <SettingsRow
      title={searchableSetting("network-access").title}
      description={
        isLocalBackendNetworkAccessible ? (
          <NetworkAccessDescription
            endpoint={defaultDesktopNetworkAdvertisedEndpoint}
            hiddenEndpointCount={Math.max(visibleDesktopNetworkAdvertisedEndpoints.length - 1, 0)}
            expanded={isAdvertisedEndpointListExpanded}
            onToggleExpanded={() => setIsAdvertisedEndpointListExpanded((expanded) => !expanded)}
            fallback={
              desktopServerExposureState?.endpointUrl
                ? `Reachable at ${desktopServerExposureState.endpointUrl}`
                : desktopServerExposureState?.advertisedHost
                  ? `Exposed on all interfaces. Pairing links use ${desktopServerExposureState.advertisedHost}.`
                  : "Exposed on all interfaces."
            }
          />
        ) : desktopServerExposureState ? (
          "Limited to this machine."
        ) : (
          "Loading…"
        )
      }
      status={
        desktopServerExposureError ? (
          <span className="block text-destructive">{desktopServerExposureError}</span>
        ) : null
      }
      control={renderNetworkAccessToggle()}
      managed={isLocalBackendNetworkAccessible ? undefined : remoteClientsDenial}
    />
  );
  const renderDisabledNetworkAccessRow = () => (
    <SettingsRow
      title={searchableSetting("network-access").title}
      description={
        desktopBridge
          ? "This connection cannot view or change network exposure."
          : currentAuthPolicy === "remote-reachable"
            ? "Remote access is already configured. Change network exposure where the server starts."
            : currentAuthPolicy === "loopback-browser"
              ? "Only this machine can connect. Restart with a non-loopback host for remote pairing."
              : "Network exposure information is unavailable."
      }
      control={
        !desktopBridge &&
        (currentAuthPolicy === "remote-reachable" || currentAuthPolicy === "loopback-browser") ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex">
                  <Switch
                    checked={isLocalBackendNetworkAccessible}
                    disabled
                    aria-label="Enable network access"
                  />
                </span>
              }
            />
            <TooltipPopup side="top">
              Network exposure changes restart the backend and must be controlled where the server
              process is launched.
            </TooltipPopup>
          </Tooltip>
        ) : undefined
      }
    />
  );

  const primarySettings = (
    <>
      {primaryEnvironmentId !== null ? (
        <>
          <SettingsSection
            {...searchableSetting("connections-environment")}
            title={
              primaryEnvironment?.label ?? (desktopBridge ? "This machine" : "Primary environment")
            }
            icon={
              <EnvironmentMachineIcon
                aria-hidden
                kind={
                  primaryServerConfig
                    ? resolveEnvironmentMachineKind(primaryServerConfig)
                    : "desktop"
                }
                className="size-4"
              />
            }
            headerAction={
              primaryEnvironmentId !== null ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost-muted"
                        size="icon-xs"
                        aria-label="More actions for this machine"
                      />
                    }
                  >
                    <EllipsisIcon className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <EnvironmentIconMenu
                      environmentId={primaryEnvironmentId}
                      serverConfig={primaryServerConfig}
                    />
                  </MenuPopup>
                </Menu>
              ) : null
            }
          >
            {primaryManagedPolicy ? (
              <div className="px-3 py-2 sm:px-4">
                <ManagedByOrganization policy={primaryManagedPolicy} />
              </div>
            ) : null}
            {canManageLocalBackend ? (
              <SettingsRow
                title="Version"
                description={
                  primaryServerUpdateState.status !== "idle" ? (
                    <ServerUpdateProgress state={primaryServerUpdateState} />
                  ) : (
                    [
                      primaryServerConfig?.environment.serverVersion ?? null,
                      primaryEnvironment?.displayUrl ?? null,
                    ]
                      .filter((value): value is string => value !== null)
                      .join(" · ") || "Loading…"
                  )
                }
                control={
                  primaryVersionMismatch &&
                  primaryEnvironmentId !== null &&
                  primaryServerUpdateState.status !== "running" ? (
                    <ServerUpdateAction
                      size="sm"
                      environmentId={primaryEnvironmentId}
                      serverLabel={
                        primaryEnvironment ? `${primaryEnvironment.label} server` : "server"
                      }
                      selfUpdate={resolveServerSelfUpdateCapability(primaryServerConfig)}
                      installation={
                        primaryServerConfig?.environment.capabilities.serverInstallation
                      }
                      desktopAppUpdate={supportsDesktopAppUpdate(primaryServerConfig)}
                      targetVersion={primaryVersionMismatch.clientVersion}
                      label={
                        primaryServerUpdateState.status === "failed"
                          ? "Retry update"
                          : `Update to ${primaryVersionMismatch.clientVersion}`
                      }
                    />
                  ) : primaryServerUpdateState.status === "idle" && primaryServerConfig ? (
                    <LocalVersionStatusLabel />
                  ) : undefined
                }
              />
            ) : null}
            {canManageLocalBackend && desktopBridge ? (
              <>
                {renderNetworkAccessRow()}
                {renderEndpointRows()}
              </>
            ) : canManageLocalBackend ? (
              renderDisabledNetworkAccessRow()
            ) : null}
            {primaryEnvironment ? (
              <details className="group px-3 sm:px-4">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                  Permissions
                  <ChevronRightIcon
                    aria-hidden
                    className="size-3 text-muted-foreground group-open:rotate-90"
                  />
                </summary>
                <SessionPermissions
                  environmentId={primaryEnvironment.environmentId}
                  connected={primaryEnvironment.connection.phase === "connected"}
                />
              </details>
            ) : null}
          </SettingsSection>

          {canReadAccess || canWriteAccess ? (
            <FoldedSettingsSection
              id="authorized-clients"
              title="Authorized clients"
              summary={summarizeAuthorizedClients(
                desktopClientSessions,
                visibleDesktopPairingLinks,
              )}
              control={
                canWriteAccess ? (
                  <AuthorizedClientsHeaderAction
                    delegatableScopes={currentSessionScopes ?? []}
                    onPairingLinkCreated={handlePairingLinkCreated}
                    clientSessions={
                      canReadAccess &&
                      authAccessChanges.error === null &&
                      authAccessChanges.data?.type === "snapshot"
                        ? desktopClientSessions
                        : null
                    }
                    isRevokingOtherClients={isRevokingOtherDesktopClients}
                    onRevokeOtherClients={handleRevokeOtherDesktopClients}
                  />
                ) : undefined
              }
            >
              <ScrollArea
                scrollFade
                chainVerticalScroll
                className="max-h-[22.5rem]"
                data-testid="authorized-clients-scroll-area"
              >
                {canReadAccess ? (
                  renderAuthorizedClients()
                ) : (
                  <p className="px-4 py-3 text-xs text-muted-foreground">
                    This connection can create access links but cannot view authorized clients.
                  </p>
                )}
              </ScrollArea>
            </FoldedSettingsSection>
          ) : null}
          <AlertDialog
            open={pendingDesktopServerExposureMode !== null && canManageLocalBackend}
            onOpenChange={(open) => {
              if (!open && !isUpdatingDesktopServerExposure)
                setPendingDesktopServerExposureMode(null);
            }}
          >
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {pendingDesktopServerExposureMode === "network-accessible"
                    ? "Enable network access?"
                    : "Disable network access?"}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingDesktopServerExposureMode === "network-accessible"
                    ? `Let your other devices connect to ${BRAND.app.productName} over the network. Pair devices to give them access. ${BRAND.app.productName} will restart.`
                    : `Devices connected over your local network will disconnect. ${BRAND.app.productName} will restart.`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={isUpdatingDesktopServerExposure}
                  render={<Button variant="outline" disabled={isUpdatingDesktopServerExposure} />}
                >
                  <span className="[text-box:trim-both_cap_alphabetic]">Cancel</span>
                </AlertDialogClose>
                <Button
                  variant="default"
                  onClick={handleConfirmDesktopServerExposureChange}
                  disabled={
                    !canManageLocalBackend ||
                    pendingDesktopServerExposureMode === null ||
                    isUpdatingDesktopServerExposure
                  }
                >
                  {isUpdatingDesktopServerExposure && <Spinner size="sm" />}
                  <span className="[text-box:trim-both_cap_alphabetic]">
                    {isUpdatingDesktopServerExposure
                      ? "Restarting…"
                      : pendingDesktopServerExposureMode === "network-accessible"
                        ? "Restart and enable"
                        : "Restart and disable"}
                  </span>
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </>
      ) : (
        <SettingsSection {...searchableSetting("connections-environment")}>
          <SettingsRow
            title="No environment selected"
            description="Connect an environment to view its settings and access."
          />
        </SettingsSection>
      )}
    </>
  );

  if (showsAccess) return <SettingsPageContainer>{primarySettings}</SettingsPageContainer>;

  return (
    <SettingsPageContainer>
      {desktopBridge ? (
        <SettingsSection id="this-app" title="This app">
          <LocalEnvironmentSetting />
        </SettingsSection>
      ) : null}
      <SettingsSection
        {...searchableSetting("remote-environments")}
        title="Environments"
        headerAction={
          <div className="flex items-center gap-1">
            {savedServerUpdateTargets.length > 0 ? (
              <ServerUpdatesAction targets={savedServerUpdateTargets} variant="ghost-muted" />
            ) : null}
            <AddEnvironmentDialog
              open={addBackendDialogOpen}
              routeTarget={routeTarget}
              error={savedBackendError}
              onOpenChange={handleAddBackendDialogOpenChange}
              onErrorChange={setSavedBackendError}
            />
          </div>
        }
      >
        {listedEnvironments.map((environment) => (
          <SavedBackendListRow
            key={environment.environmentId}
            environment={environment}
            removingEnvironmentId={removingSavedEnvironmentId}
            onSetEnabled={handleSetSavedBackendEnabled}
            onRemove={handleRemoveSavedBackend}
            onAddRoute={(target) => {
              setRouteTarget(target);
              setSavedBackendError(null);
              setAddBackendDialogOpen(true);
            }}
          />
        ))}
        {savedEnvironments.length === 0 ? <EmptyRemoteEnvironments /> : null}
      </SettingsSection>
      {peerLinkHosts.map((environment, index) => (
        <LinkedEnvironmentsSettings
          key={environment.environmentId}
          environmentId={environment.environmentId}
          environmentLabel={peerLinkHosts.length > 1 ? environment.label : null}
          isSearchTarget={index === 0}
        />
      ))}
      <LoadBalancingSettings environments={loadBalancingEnvironments} />
    </SettingsPageContainer>
  );
}
