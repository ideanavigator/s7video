// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Settings → Providers' speech model item (S7V-067): shown once the server answers, or a plain
 * line when its engine can't. The card carries the visible "Speech model" label.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { useSpeechModelStatusState } from "../../editor/editStore";
import { SpeechModelSetup } from "../editor/SpeechModelSetup";
import { SettingsSection } from "./settingsLayout";

export function SpeechModelSettings(props: { readonly environmentId: EnvironmentId }) {
  const state = useSpeechModelStatusState(props.environmentId);
  if (state._tag === "loading") return null;
  return (
    <SettingsSection title="Speech model" hideTitle variant="plain">
      {state._tag === "unavailable" ? (
        <p className="text-sm text-muted-foreground">
          Speech model status unavailable. The video engine on this computer isn't answering right
          now.
        </p>
      ) : (
        <SpeechModelSetup environmentId={props.environmentId} />
      )}
    </SettingsSection>
  );
}
