import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";

import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { usePeerLinkHosts } from "~/state/peerLinks";
import { useEnvironmentScope } from "~/state/session";
import { offeredUsageData } from "./PrivacySettings.logic";
import { isProviderSettingsEnvironmentAvailable } from "./ProviderSettingsPanel.logic";
import type { SettingsScopeSearch } from "./settingsScope";
import {
  filterAvailableSettingsSearchItems,
  getThreadAutoSettlementSearchAvailability,
} from "./settingsSearch";

export function useAvailableSettingsSearchItems(scopeSearch: SettingsScopeSearch = {}) {
  const { environments } = useEnvironments();
  // Explicit booleans keep flags out of the filter cache so environment updates do not rebuild the list.
  const hasEnvironment =
    environments.some((environment) => environment.serverConfig !== null) === true;
  const hasProviderSettingsEnvironment =
    environments.some((environment) =>
      isProviderSettingsEnvironmentAvailable({
        connectionPhase: environment.connection.phase,
        hasServerConfig: environment.serverConfig !== null,
      }),
    ) === true;
  const hasMacProviderSettingsEnvironment =
    environments.some(
      (environment) =>
        (scopeSearch.machine === undefined || environment.environmentId === scopeSearch.machine) &&
        environment.serverConfig?.environment.platform.os === "darwin" &&
        isProviderSettingsEnvironmentAvailable({
          connectionPhase: environment.connection.phase,
          hasServerConfig: true,
        }),
    ) === true;
  const hasThreadAutoSettlement =
    getThreadAutoSettlementSearchAvailability(environments).eligibleEnvironmentIds.length > 0;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canMaintain = useEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope);
  const hasPeerLinkHost = usePeerLinkHosts().length > 0;
  const hasUsageDataSharing = offeredUsageData(environments) !== null;
  const localEnvironmentDisabled = isLocalEnvironmentDisabled() === true;
  const canManageLocalBackend = !localEnvironmentDisabled && canMaintain;

  return filterAvailableSettingsSearchItems({
    localEnvironmentDisabled,
    hasEnvironment,
    hasProviderSettingsEnvironment,
    hasMacProviderSettingsEnvironment,
    canManageLocalBackend,
    hasThreadAutoSettlement,
    hasPeerLinkHost,
    hasUsageDataSharing,
  });
}
