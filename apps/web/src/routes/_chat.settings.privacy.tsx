// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { createFileRoute } from "@tanstack/react-router";
import { PrivacySettingsPanel } from "../components/settings/PrivacySettings";

export const Route = createFileRoute("/_chat/settings/privacy")({
  component: PrivacySettingsPanel,
});
