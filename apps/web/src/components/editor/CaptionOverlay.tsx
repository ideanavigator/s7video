// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Captions over the player (S7V-075): stills drawn by the export's own renderer (libass), one per
 * caption chunk, shown at the frame the export shows them. The still is swapped from the player's
 * frame clock outside React. While new stills are drawn the old ones stay, with a small note. The
 * image URLs are built once per reply (the React Compiler memoizes them on `stills.stills`).
 */
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { CaptionStillsResult, ScopedProjectRef } from "@t3tools/contracts";
import { stillAt } from "../../editor/captionStills";
import {
  rememberedPlayerFrame,
  selectPlayerSource,
  subscribePlayerFrame,
  useCaptionStills,
  useEditPlayerStore,
} from "../../editor/editStore";

/** Shows the edit's captions; nothing while a clip or a saved version plays. */
export function CaptionOverlay(props: { readonly projectRef: ScopedProjectRef }) {
  const projectKey = scopedProjectKey(props.projectRef);
  const source = useEditPlayerStore((state) =>
    selectPlayerSource(state.sourceByProjectKey, projectKey),
  );
  const state = useCaptionStills(props.projectRef);
  if (source.kind !== "edit" || state._tag === "none") return null;
  return (
    <>
      {state.stills.chunks.length === 0 ? null : (
        <CaptionStill key={state.stills.key} projectKey={projectKey} stills={state.stills} />
      )}
      {state.updating || state.stills.missing.length > 0 ? (
        <div className="absolute top-2 left-2 flex max-w-[90%] flex-col items-start gap-1 text-xs text-white">
          {state.updating ? (
            <span role="status" className="rounded bg-black/60 px-2 py-0.5">
              Updating captions…
            </span>
          ) : null}
          {state.stills.missing.length > 0 ? (
            // S7V-075: a clip whose transcript can't be read keeps its captions as they were.
            <span role="status" className="rounded bg-black/60 px-2 py-0.5">
              No transcript for {state.stills.missing.join(", ")}: its captions can't follow your
              cuts. Transcribe it again.
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function CaptionStill(props: {
  readonly projectKey: string;
  readonly stills: CaptionStillsResult;
}) {
  const { projectKey, stills } = props;
  const urls = stills.stills.map((still) => `data:image/png;base64,${still}`);

  const attach = (image: HTMLImageElement) => {
    // Swapped only when the chunk changes: a new `src` decodes the still again.
    let shown = -2;
    const show = (frame: number) => {
      const still = stillAt(stills.chunks, frame);
      if (still === shown) return;
      shown = still;
      if (still === -1) {
        image.hidden = true;
        return;
      }
      image.src = urls[still]!;
      image.hidden = false;
    };
    show(rememberedPlayerFrame(projectKey));
    return subscribePlayerFrame(projectKey, show);
  };

  return (
    <img
      ref={attach}
      alt=""
      aria-hidden
      hidden
      data-testid="caption-overlay"
      className="pointer-events-none absolute inset-0 size-full select-none"
    />
  );
}
