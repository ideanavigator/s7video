// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Captions over the player (S7V-075): stills drawn by the export's own renderer (libass), one per
 * caption chunk, shown at the frame the export shows them. The still is swapped from the player's
 * frame clock outside React. The stills are fetched by key (S7V-079): while new ones are drawn or
 * fetched, the old ones stay, with a small note.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { CaptionStillsResult, ScopedProjectRef } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { stillAt } from "../../editor/captionStills";
import {
  captionStillCacheAtom,
  type ShownCaptionStills,
  settledCaptionStills,
} from "../../editor/captionStillUrls";
import {
  type CaptionStillsState,
  rememberedPlayerFrame,
  selectPlayerSource,
  subscribePlayerFrame,
  useCaptionStills,
  useEditPlayerStore,
} from "../../editor/editStore";
import { usePreparedConnection } from "../../state/session";

/**
 * The reply's stills when they have all loaded (at once when they are cached), else the newest
 * reply shown before. The cache lives in a per-project atom, so it is freed once unused.
 */
function useShownStills(
  projectRef: ScopedProjectRef,
  projectKey: string,
  state: CaptionStillsState,
): ShownCaptionStills | null {
  const connection = usePreparedConnection(projectRef.environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const cache = useAtomValue(captionStillCacheAtom(projectKey));
  const snapshot = useSyncExternalStore(cache.subscribe, cache.snapshot);
  const stills = state._tag === "ready" ? state.stills : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the reply's stills from the asset route into the cache's object URLs; only the newest reply lands
  useEffect(() => {
    if (stills === null || httpBaseUrl === null) return;
    void cache.load(stills, httpBaseUrl);
  }, [cache, stills, httpBaseUrl]);
  const settled = stills === null ? null : settledCaptionStills(snapshot, stills);
  return stills !== null && settled !== null ? { stills, urls: settled } : snapshot.shown;
}

/** Shows the edit's captions; nothing while a clip or a saved version plays. */
export function CaptionOverlay(props: { readonly projectRef: ScopedProjectRef }) {
  const projectKey = scopedProjectKey(props.projectRef);
  const source = useEditPlayerStore((state) =>
    selectPlayerSource(state.sourceByProjectKey, projectKey),
  );
  const state = useCaptionStills(props.projectRef);
  const loaded = useShownStills(props.projectRef, projectKey, state);
  if (source.kind !== "edit" || state._tag === "none") return null;
  const updating = state.updating || loaded?.stills !== state.stills;
  return (
    <>
      {loaded === null || loaded.stills.chunks.length === 0 ? null : (
        <CaptionStill
          key={loaded.stills.key}
          projectKey={projectKey}
          chunks={loaded.stills.chunks}
          urls={loaded.urls}
        />
      )}
      {updating || state.stills.missing.length > 0 ? (
        <div className="absolute top-2 left-2 flex max-w-[90%] flex-col items-start gap-1 text-xs text-white">
          {updating ? (
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
  readonly chunks: CaptionStillsResult["chunks"];
  readonly urls: ReadonlyArray<string | null>;
}) {
  const { projectKey, chunks, urls } = props;

  const attach = (image: HTMLImageElement) => {
    // Swapped only when the chunk changes: a new `src` decodes the still again.
    let shown = -2;
    const show = (frame: number) => {
      const still = stillAt(chunks, frame);
      if (still === shown) return;
      shown = still;
      const url = still === -1 ? null : urls[still];
      if (url === null || url === undefined) {
        image.hidden = true;
        return;
      }
      image.src = url;
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
