import { createFileRoute } from "@tanstack/react-router";
import { PrivacySettingsPanel } from "../components/settings/PrivacySettings";

export const Route = createFileRoute("/_chat/settings/privacy")({
  component: PrivacySettingsPanel,
});
