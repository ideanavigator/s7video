// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The Editor panel's Versions tab (S7V-069): every version of the project's edit, newest first,
 * shared by all its chats. The newest is Main (S7V-076). Another row can be previewed (read only),
 * named, made main again (which adds a new version, so nothing is lost) or deleted.
 */
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  EDIT_VERSION_TAG_MAX,
  type EditDocument,
  type EditVersion,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { HistoryIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import {
  editEnvironment,
  type ProjectVersionsState,
  refreshProjectVersions,
  useProjectEdit,
  useProjectVersions,
} from "../../editor/editStore";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

const authorWords = { assistant: "Assistant", you: "You", outside: "Outside the app" } as const;
const spokenAuthor = {
  assistant: "by the assistant",
  you: "by you",
  outside: "changed outside the app",
} as const;

const timeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const whenOf = (version: EditVersion) => timeFormat.format(version.at);

interface VersionsListProps {
  readonly state: ProjectVersionsState;
  /** The version playing in the player, if one is previewed. */
  readonly previewing: number | null;
  readonly onPreview: (version: EditVersion) => void;
  readonly onTag: (version: EditVersion) => void;
  readonly onRestore: (version: EditVersion) => void;
  readonly onDelete: (version: EditVersion) => void;
  /** A link to the chat that made it; the container renders a router link. */
  readonly renderChatLink: (version: EditVersion) => ReactNode;
}

function VersionRow(props: VersionsListProps & { readonly version: EditVersion }) {
  const { version } = props;
  const previewing = props.previewing === version.n;
  const when = whenOf(version);
  const summary = version.changes.join("; ");
  return (
    <div
      role="listitem"
      aria-label={[
        `Version ${version.n}`,
        version.tag,
        spokenAuthor[version.author],
        when,
        version.current ? "main" : undefined,
        previewing ? "previewing" : undefined,
      ]
        .filter(Boolean)
        .join(", ")}
      data-current={version.current}
      className="flex flex-col gap-1 rounded-md px-2 py-1.5 hover:bg-accent data-[current=true]:bg-muted/40"
    >
      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        <span className="shrink-0 font-medium tabular-nums">v{version.n}</span>
        {version.tag !== undefined && (
          <span className="min-w-0 truncate font-medium">{version.tag}</span>
        )}
        {version.current && (
          <Badge variant="info" size="sm">
            Main
          </Badge>
        )}
        {previewing && (
          <Badge variant="outline" size="sm">
            Previewing
          </Badge>
        )}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {authorWords[version.author]} · {when}
        </span>
      </div>
      {/* Actions share the summary's line, so the tab shows four versions at 1440x900 (S7V-076). */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="line-clamp-2 min-w-0 flex-1 basis-48 text-xs text-muted-foreground">
          {summary}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          {!version.current && (
            <Button
              size="xs"
              variant="outline"
              disabled={previewing}
              onClick={() => props.onPreview(version)}
            >
              Preview
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={() => props.onTag(version)}>
            {version.tag === undefined ? "Name…" : "Rename…"}
          </Button>
          {!version.current && (
            <>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`Make main, version ${version.n}`}
                onClick={() => props.onRestore(version)}
              >
                Make main
              </Button>
              <Button size="xs" variant="ghost" onClick={() => props.onDelete(version)}>
                Delete
              </Button>
            </>
          )}
          {props.renderChatLink(version)}
        </div>
      </div>
    </div>
  );
}

function VersionsList(props: VersionsListProps) {
  if (props.state._tag === "loading") {
    return (
      <div className="flex h-full items-center justify-center" role="status">
        <Spinner aria-label="Loading versions" />
      </div>
    );
  }
  if (props.state._tag === "unavailable") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Versions aren't available</EmptyTitle>
          <EmptyDescription>{props.state.message}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (props.state.versions.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HistoryIcon />
          </EmptyMedia>
          <EmptyTitle>No versions yet</EmptyTitle>
          <EmptyDescription>Ask the assistant for a change, or drop a video here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div role="list" aria-label="Versions" className="flex h-full flex-col gap-0.5 overflow-y-auto">
      {props.state.versions.map((version) => (
        <VersionRow key={version.n} {...props} version={version} />
      ))}
    </div>
  );
}

/** Names a version; an empty name clears it. */
function TagDialog(props: {
  readonly version: EditVersion | null;
  readonly error: string | null;
  readonly onSave: (tag: string | null) => void;
  readonly onCancel: () => void;
}) {
  return (
    <Dialog open={props.version !== null} onOpenChange={(open) => !open && props.onCancel()}>
      {props.version !== null && (
        <TagForm
          key={props.version.n}
          version={props.version}
          error={props.error}
          onSave={props.onSave}
          onCancel={props.onCancel}
        />
      )}
    </Dialog>
  );
}

function TagForm(props: {
  readonly version: EditVersion;
  readonly error: string | null;
  readonly onSave: (tag: string | null) => void;
  readonly onCancel: () => void;
}) {
  const [value, setValue] = useState(props.version.tag ?? "");
  const inputId = useId();
  const errorId = useId();
  const trimmed = value.trim();
  return (
    <DialogPopup>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          props.onSave(trimmed === "" ? null : trimmed);
        }}
      >
        <DialogHeader>
          <DialogTitle>Name v{props.version.n}</DialogTitle>
          <DialogDescription>
            A short name, such as "tight cut". Each name is used once in this project. Leave it
            empty to remove the name.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label htmlFor={inputId} className="sr-only">
            Version name
          </label>
          <Input
            id={inputId}
            value={value}
            maxLength={EDIT_VERSION_TAG_MAX}
            autoFocus
            aria-invalid={props.error !== null}
            aria-describedby={props.error === null ? undefined : errorId}
            onChange={(event) => setValue(event.target.value)}
          />
          {props.error !== null && (
            <p id={errorId} role="alert" className="mt-2 text-sm text-destructive-foreground">
              {props.error}
            </p>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" size="sm" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm">
            Save
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}

const messageOf = (error: unknown, fallback: string) =>
  error instanceof Error && error.message !== "" ? error.message : fallback;

export function VersionsTab(props: {
  readonly projectRef: ScopedProjectRef;
  readonly previewing: number | null;
  /** Plays a version in the player, read only. */
  readonly onPreview: (n: number, document: EditDocument) => void;
  /** Back to the current edit, after a restore. */
  readonly onShowCurrent: () => void;
}) {
  const { projectRef } = props;
  const { environmentId, projectId } = projectRef;
  const state = useProjectVersions(projectRef);
  const edit = useProjectEdit(projectRef);
  const getVersion = useAtomCommand(editEnvironment.versionGet, { reportFailure: false });
  const tagVersion = useAtomCommand(editEnvironment.versionTag, { reportFailure: false });
  const restoreVersion = useAtomCommand(editEnvironment.versionRestore, { reportFailure: false });
  const deleteVersion = useAtomCommand(editEnvironment.versionDelete, { reportFailure: false });
  const [tagging, setTagging] = useState<EditVersion | null>(null);
  const [tagError, setTagError] = useState<string | null>(null);

  const preview = async (version: EditVersion) => {
    const result = await getVersion({ environmentId, input: { projectId, n: version.n } });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `Couldn't preview v${version.n}`,
        description: messageOf(squashAtomCommandFailure(result), "Try again."),
      });
      return;
    }
    props.onPreview(version.n, result.value.document);
  };

  const saveTag = async (tag: string | null) => {
    if (tagging === null) return;
    const result = await tagVersion({ environmentId, input: { projectId, n: tagging.n, tag } });
    if (result._tag === "Failure") {
      setTagError(messageOf(squashAtomCommandFailure(result), "The name couldn't be saved."));
      return;
    }
    setTagging(null);
    setTagError(null);
    refreshProjectVersions(projectRef);
  };

  const restore = async (version: EditVersion) => {
    if (edit._tag !== "ready") return;
    const result = await restoreVersion({
      environmentId,
      input: { projectId, n: version.n, baseRevision: edit.snapshot.revision },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `Couldn't make v${version.n} main`,
        description: messageOf(squashAtomCommandFailure(result), "Try again."),
      });
      return;
    }
    props.onShowCurrent();
  };

  const remove = async (version: EditVersion) => {
    const confirmed =
      (await requestConfirmDialog(
        `Delete v${version.n}${version.tag === undefined ? "" : ` "${version.tag}"`}? Your clips in Media are not touched.`,
        { variant: "destructive" },
      )) ?? false;
    if (!confirmed) return;
    const result = await deleteVersion({ environmentId, input: { projectId, n: version.n } });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `Couldn't delete v${version.n}`,
        description: messageOf(squashAtomCommandFailure(result), "Try again."),
      });
      return;
    }
    if (props.previewing === version.n) props.onShowCurrent();
    refreshProjectVersions(projectRef);
  };

  return (
    <>
      <VersionsList
        state={state}
        previewing={props.previewing}
        onPreview={(version) => void preview(version)}
        onTag={(version) => {
          setTagError(null);
          setTagging(version);
        }}
        onRestore={(version) => void restore(version)}
        onDelete={(version) => void remove(version)}
        renderChatLink={(version) =>
          version.threadId === undefined ? null : (
            <Button
              size="xs"
              variant="link"
              render={
                <Link
                  to="/$environmentId/$threadId"
                  params={buildThreadRouteParams({ environmentId, threadId: version.threadId })}
                />
              }
            >
              Open chat
            </Button>
          )
        }
      />
      <TagDialog
        version={tagging}
        error={tagError}
        onSave={(tag) => void saveTag(tag)}
        onCancel={() => {
          setTagging(null);
          setTagError(null);
        }}
      />
    </>
  );
}
