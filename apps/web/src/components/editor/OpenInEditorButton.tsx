// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadShell } from "../../state/entities";
import { InlineButton } from "../ui/button";

/** "Open in Editor" on a video tool's row in the chat (S7V-029). */
export function OpenInEditorButton(props: { readonly threadRef: ScopedThreadRef }) {
  const projectId = useThreadShell(props.threadRef)?.projectId ?? null;
  if (projectId === null) return null;
  return (
    <InlineButton
      aria-label="Open in Editor"
      onClick={(event) => {
        event.stopPropagation();
        useRightPanelStore.getState().openEditor(props.threadRef, projectId);
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      Open in Editor
    </InlineButton>
  );
}
