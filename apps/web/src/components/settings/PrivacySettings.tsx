import { BRAND } from "@t3tools/shared/brand";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { PRIVACY_POLICY_URL } from "../../legalLinks";
import { managedTelemetryOffMessage, usePrimaryManagedPolicy } from "../../state/managedPolicy";
import { Button } from "../ui/button";
import { offeredUsageData } from "./PrivacySettings.logic";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function PrivacySettingsPanel() {
  const telemetryOff = managedTelemetryOffMessage(usePrimaryManagedPolicy());
  const { connectedEnvironments } = useSettingsScope();
  const usageData = offeredUsageData(connectedEnvironments);
  return (
    <SettingsPageContainer>
      <SettingsSection id="privacy" title="Privacy">
        <SettingsRow
          {...searchableSetting("privacy-policy")}
          description={`How ${BRAND.app.productName} handles your data. ${
            telemetryOff ?? "No usage data is sent unless you turn it on."
          }`}
          control={
            <Button
              render={<a href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer noopener" />}
              size="sm"
              variant="outline"
            >
              View policy
            </Button>
          }
        />
        {usageData === null ? null : <ShareUsageDataRow variable={usageData.variable} />}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function ShareUsageDataRow({ variable }: { readonly variable: string | undefined }) {
  const shareUsageData = useScopedSettings((settings) => settings.shareUsageData);
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("share-usage-data")}
      serverScoped
      settingKeys={["shareUsageData"]}
      description="Sends product events, such as which agent and model ran, how turns ended, how long they took and token counts, with a random installation ID. Never prompts, replies, files, footage, transcripts or paths."
      status={variable === undefined ? undefined : `Set by ${variable} in the environment.`}
      resetAction={
        shareUsageData !== DEFAULT_UNIFIED_SETTINGS.shareUsageData ? (
          <SettingResetButton
            label="usage data sharing"
            onClick={() =>
              updateSettings({ shareUsageData: DEFAULT_UNIFIED_SETTINGS.shareUsageData })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["shareUsageData"]}
          checked={shareUsageData}
          disabled={variable !== undefined}
          onCheckedChange={(checked) => updateSettings({ shareUsageData: Boolean(checked) })}
          aria-label="Share anonymous usage data"
        />
      }
    />
  );
}
