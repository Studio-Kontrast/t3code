import type { EnvironmentId, GitTreeSnapshotResult, VcsStatusResult } from "@t3tools/contracts";
import { AlertTriangle, FolderGit2, GitFork, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { gitEnvironment } from "~/state/git";
import { useEnvironmentQuery } from "~/state/query";
import { sanitizeThreadErrorMessage } from "~/rpc/transportError";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { GitTreeMap } from "./GitTreeMap";

interface GitTreePanelProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly vcsRefreshToken: VcsStatusResult | null;
}

export function shouldRefreshGitTreeForVcsChange(
  previous: VcsStatusResult | null,
  next: VcsStatusResult | null,
): boolean {
  return previous !== null && next !== null && !Object.is(previous, next);
}

export function hasGitTreeActivity(
  snapshot: Extract<GitTreeSnapshotResult, { _tag: "repository" }>,
): boolean {
  return snapshot.merges.length > 0 || snapshot.directCommits.length > 0;
}

function GitTreeEmptyState(props: {
  readonly icon: typeof GitFork;
  readonly title: string;
  readonly description: string;
  readonly action?: { readonly label: string; readonly onClick: () => void };
}) {
  const Icon = props.icon;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
      <div className="max-w-sm">
        <div className="mx-auto flex size-10 items-center justify-center rounded-xl border border-border/70 bg-muted/50 text-muted-foreground">
          <Icon className="size-5" aria-hidden />
        </div>
        <h3 className="mt-3 text-sm font-medium text-foreground">{props.title}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{props.description}</p>
        {props.action ? (
          <Button className="mt-4" variant="outline" size="sm" onClick={props.action.onClick}>
            <RefreshCw aria-hidden />
            {props.action.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function GitTreeLoadingState() {
  return (
    <div
      className="relative min-h-0 flex-1 overflow-hidden p-6"
      role="status"
      aria-label="Loading Git tree"
    >
      <Skeleton className="absolute left-12 right-12 bottom-24 h-0.5 motion-reduce:animate-none" />
      {[0, 1, 2, 3].map((lane) => (
        <div
          key={lane}
          className="absolute left-16 right-24 flex items-center"
          style={{ bottom: 136 + lane * 54 }}
        >
          <Skeleton className="h-10 w-px motion-reduce:animate-none" />
          <Skeleton className="h-px flex-1 motion-reduce:animate-none" />
          <Skeleton className="size-2 rounded-full motion-reduce:animate-none" />
          <Skeleton className="ml-2 h-3 w-24 motion-reduce:animate-none" />
        </div>
      ))}
      <span className="sr-only">Loading Git tree</span>
    </div>
  );
}

function truncatedLabel(snapshot: Extract<GitTreeSnapshotResult, { _tag: "repository" }>): string {
  const values = [
    snapshot.truncated.branches ? "branches" : null,
    snapshot.truncated.merges ? "merge commits" : null,
    snapshot.truncated.directCommits ? "direct commits" : null,
  ].filter((value): value is string => value !== null);
  return values.join(", ");
}

export default function GitTreePanel({ environmentId, cwd, vcsRefreshToken }: GitTreePanelProps) {
  const query = useEnvironmentQuery(gitEnvironment.treeSnapshot({ environmentId, input: { cwd } }));
  const refreshRef = useRef(query.refresh);
  const previousVcsRefreshTokenRef = useRef(vcsRefreshToken);
  const snapshot = query.data?.requestedCwd === cwd ? query.data : null;
  const safeError =
    sanitizeThreadErrorMessage(query.error) ??
    (query.error ? "The Git history could not be loaded." : null);
  const truncation = useMemo(
    () => (snapshot?._tag === "repository" ? truncatedLabel(snapshot) : ""),
    [snapshot],
  );

  useEffect(() => {
    refreshRef.current = query.refresh;
  }, [query.refresh]);

  useEffect(() => {
    const previous = previousVcsRefreshTokenRef.current;
    previousVcsRefreshTokenRef.current = vcsRefreshToken;
    if (!shouldRefreshGitTreeForVcsChange(previous, vcsRefreshToken)) return;
    const timeout = window.setTimeout(() => refreshRef.current(), 300);
    return () => window.clearTimeout(timeout);
  }, [vcsRefreshToken]);

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background" aria-label="Git tree">
      <div className="surface-subheader gap-2 px-3">
        <GitFork className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">
            {snapshot?._tag === "repository" ? snapshot.name : "Git tree"}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {snapshot?._tag === "repository"
              ? (snapshot.currentBranch ?? "Detached HEAD")
              : "Local branch history"}
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh Git tree"
                onClick={query.refresh}
              />
            }
          >
            <RefreshCw
              className={query.isPending ? "animate-spin motion-reduce:animate-none" : undefined}
              aria-hidden
            />
          </TooltipTrigger>
          <TooltipPopup>Refresh Git tree</TooltipPopup>
        </Tooltip>
      </div>

      {truncation ? (
        <div
          className="flex items-center gap-2 border-b border-warning/20 bg-warning/8 px-3 py-2 text-xs text-warning-foreground"
          role="status"
        >
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            Large history: showing a bounded set of {truncation}.
          </span>
        </div>
      ) : null}

      {safeError ? (
        <GitTreeEmptyState
          icon={AlertTriangle}
          title="Could not load Git history"
          description={safeError}
          action={{ label: "Retry", onClick: query.refresh }}
        />
      ) : snapshot === null ? (
        <GitTreeLoadingState />
      ) : snapshot._tag === "notGitRepository" ? (
        <GitTreeEmptyState
          icon={FolderGit2}
          title="This project is not a Git repository"
          description="Open a project backed by Git to visualize its local branch history."
        />
      ) : snapshot.isEmpty || !hasGitTreeActivity(snapshot) ? (
        <GitTreeEmptyState
          icon={GitFork}
          title="No Git activity yet"
          description="Commits and branches will appear here once this repository has history."
          action={{ label: "Refresh", onClick: query.refresh }}
        />
      ) : (
        <GitTreeMap snapshot={snapshot} />
      )}
    </section>
  );
}
