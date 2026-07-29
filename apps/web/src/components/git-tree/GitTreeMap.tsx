// SPDX-FileCopyrightText: 2026 Block, Inc.
// SPDX-License-Identifier: Apache-2.0
// Adapted from Canopy's components/BranchMap.tsx at 8bc295dc1a210fbb648f4cf42203ae5d2c4c9478.

import type { GitTreeBranch, GitTreeSnapshotResult } from "@t3tools/contracts";
import { Minus, Plus } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import {
  buildGitTreeLayout,
  clampGitTreeZoom,
  GIT_TREE_ZOOM_MAX,
  GIT_TREE_ZOOM_MIN,
} from "./gitTreeLayout";

type RepositorySnapshot = Extract<GitTreeSnapshotResult, { _tag: "repository" }>;

interface GitTreeMapProps {
  readonly snapshot: RepositorySnapshot;
}

interface ZoomAnchor {
  readonly contentRatio: number;
  readonly viewportX: number;
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly scrollLeft: number;
}

const MAIN_DRAW_MS = 1_200;
const BRANCH_STAGGER_MS = 60;
const BRANCH_INFO_OFFSET_MS = 750;

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function compactDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function branchColor(branch: GitTreeBranch): string {
  if (branch.current) return "var(--primary)";
  switch (branch.status) {
    case "conflict-risk":
      return "var(--destructive)";
    case "stale":
      return "var(--warning)";
    case "fresh":
      return "var(--success)";
    case "unknown":
      return "var(--muted-foreground)";
  }
}

function branchDescription(branch: GitTreeBranch): string {
  const position = [
    branch.ahead > 0 ? `${branch.ahead} ahead` : null,
    branch.behind > 0 ? `${branch.behind} behind` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return `${branch.name}, ${position || "at the default branch"}, last commit by ${branch.lastCommitAuthor} on ${formatDate(branch.lastCommitDate)}`;
}

export function GitTreeMap({ snapshot }: GitTreeMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const zoomAnchorRef = useRef<ZoomAnchor | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const pendingZoomRef = useRef<number | null>(null);
  const [viewportHeight, setViewportHeight] = useState(420);
  const [zoom, setZoom] = useState(1);
  const [focusedBranchName, setFocusedBranchName] = useState<string | null>(null);
  const [selectedBranchName, setSelectedBranchName] = useState<string | null>(null);
  const [selectedCommitSha, setSelectedCommitSha] = useState<string | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [drawReady, setDrawReady] = useState(false);

  const layout = useMemo(
    () =>
      buildGitTreeLayout({
        branches: snapshot.branches,
        merges: snapshot.merges,
        directCommits: snapshot.directCommits,
        defaultBranch: snapshot.defaultBranch,
        viewportHeight,
        zoom,
      }),
    [snapshot, viewportHeight, zoom],
  );

  const selectedBranch = useMemo(
    () => snapshot.branches.find((branch) => branch.name === selectedBranchName) ?? null,
    [selectedBranchName, snapshot.branches],
  );
  const selectedCommit = useMemo(
    () => snapshot.directCommits.find((commit) => commit.fullSha === selectedCommitSha) ?? null,
    [selectedCommitSha, snapshot.directCommits],
  );

  useEffect(() => {
    setDrawReady(false);
    let cancelled = false;
    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = requestAnimationFrame(() => {
      if (cancelled) return;
      secondFrame = requestAnimationFrame(() => {
        if (!cancelled) setDrawReady(true);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [snapshot.root]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateHeight = () => {
      const nextHeight = Math.max(260, Math.round(container.getBoundingClientRect().height));
      setViewportHeight((current) => (current === nextHeight ? current : nextHeight));
    };
    const observer = new ResizeObserver(updateHeight);
    observer.observe(container);
    updateHeight();
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    const scroll = scrollRef.current;
    if (!anchor || !scroll) return;
    zoomAnchorRef.current = null;
    scroll.scrollLeft = anchor.contentRatio * scroll.scrollWidth - anchor.viewportX;
  }, [zoom, layout.width]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const scroll = scrollRef.current;
      if (scroll) scroll.scrollLeft = scroll.scrollWidth;
    });
    return () => cancelAnimationFrame(frame);
  }, [snapshot.root]);

  useEffect(
    () => () => {
      if (zoomFrameRef.current !== null) cancelAnimationFrame(zoomFrameRef.current);
    },
    [],
  );

  const requestZoom = useCallback((nextZoom: number, viewportX?: number) => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const resolvedViewportX = viewportX ?? scroll.clientWidth / 2;
    const contentX = scroll.scrollLeft + resolvedViewportX;
    zoomAnchorRef.current = {
      contentRatio: scroll.scrollWidth > 0 ? contentX / scroll.scrollWidth : 0,
      viewportX: resolvedViewportX,
    };
    pendingZoomRef.current = clampGitTreeZoom(nextZoom);
    if (zoomFrameRef.current !== null) return;
    zoomFrameRef.current = requestAnimationFrame(() => {
      zoomFrameRef.current = null;
      const pending = pendingZoomRef.current;
      pendingZoomRef.current = null;
      if (pending !== null) setZoom(pending);
    });
  }, []);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = scroll.getBoundingClientRect();
      const direction = event.deltaY > 0 ? -0.12 : 0.12;
      requestZoom((pendingZoomRef.current ?? zoom) + direction, event.clientX - rect.left);
    };
    scroll.addEventListener("wheel", handleWheel, { passive: false });
    return () => scroll.removeEventListener("wheel", handleWheel);
  }, [requestZoom, zoom]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as Element).closest("[data-git-tree-interactive]")) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      scrollLeft: event.currentTarget.scrollLeft,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsPanning(true);
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.currentTarget.scrollLeft = drag.scrollLeft - (event.clientX - drag.startX);
  }, []);

  const finishPanning = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsPanning(false);
  }, []);

  const activateBranch = useCallback((branch: GitTreeBranch) => {
    setSelectedCommitSha(null);
    setSelectedBranchName((current) => (current === branch.name ? null : branch.name));
  }, []);

  const activateCommit = useCallback((fullSha: string) => {
    setSelectedBranchName(null);
    setSelectedCommitSha((current) => (current === fullSha ? null : fullSha));
  }, []);

  const handleBranchKeyDown = useCallback(
    (event: KeyboardEvent<SVGGElement>, branch: GitTreeBranch) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activateBranch(branch);
    },
    [activateBranch],
  );

  const handleCommitKeyDown = useCallback(
    (event: KeyboardEvent<SVGGElement>, fullSha: string) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activateCommit(fullSha);
    },
    [activateCommit],
  );

  const hasFocus = focusedBranchName !== null || selectedBranchName !== null;
  const activeBranchName = selectedBranchName ?? focusedBranchName;
  const defaultBranchLabel = snapshot.defaultBranch ?? snapshot.currentBranch ?? "HEAD";

  return (
    <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden bg-background">
      <div
        ref={scrollRef}
        className={cn(
          "size-full touch-pan-y select-none overflow-auto overscroll-contain",
          isPanning ? "cursor-grabbing" : "cursor-grab",
        )}
        role="region"
        aria-label="Git history visualization. Drag horizontally to pan and hold Control while scrolling to zoom."
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPanning}
        onPointerCancel={finishPanning}
      >
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className={cn("block max-w-none", drawReady && "git-tree-timeline-ready")}
          role="group"
          aria-labelledby="git-tree-map-title git-tree-map-description"
        >
          <title id="git-tree-map-title">Git history for {snapshot.name}</title>
          <desc id="git-tree-map-description">
            {snapshot.branches.length} branches, {snapshot.merges.length} merge commits, and{" "}
            {snapshot.directCommits.length} direct commits.
          </desc>
          <defs>
            <filter id="git-tree-node-shadow" x="-100%" y="-100%" width="300%" height="300%">
              <feDropShadow dx="0" dy="1" stdDeviation="2" floodOpacity="0.16" />
            </filter>
          </defs>

          <g
            className="transition-opacity duration-150 ease-in-out motion-reduce:transition-none"
            opacity={hasFocus ? 0.35 : 1}
          >
            <path
              d={`M ${layout.mainStartX} ${layout.mainY} L ${layout.mainEndX} ${layout.mainY}`}
              fill="none"
              stroke="var(--muted-foreground)"
              strokeWidth={1.5}
              pathLength={1}
              className="git-tree-draw-main"
            />
            <g
              className="git-tree-fade-info"
              style={{ "--git-tree-delay": `${MAIN_DRAW_MS}ms` } as CSSProperties}
            >
              <path
                d={`M ${layout.mainEndX} ${layout.mainY} L ${layout.width - 84} ${layout.mainY}`}
                fill="none"
                stroke="var(--muted-foreground)"
                strokeDasharray="6 6"
                strokeWidth={1.5}
              />
              <text
                x={layout.width - 76}
                y={layout.mainY + 4}
                fill="var(--foreground)"
                fontSize={12}
                fontWeight={600}
              >
                {defaultBranchLabel}
              </text>

              {layout.directCommits.map(({ commit, x }) => {
                const active = selectedCommitSha === commit.fullSha;
                return (
                  <g
                    key={commit.fullSha}
                    data-git-tree-interactive
                    role="button"
                    tabIndex={0}
                    aria-label={`${commit.sha}, ${commit.message}, by ${commit.author} on ${formatDate(commit.date)}`}
                    aria-pressed={active}
                    className="cursor-pointer outline-none focus-visible:[&_rect]:stroke-[var(--ring)]"
                    onClick={() => activateCommit(commit.fullSha)}
                    onKeyDown={(event) => handleCommitKeyDown(event, commit.fullSha)}
                  >
                    <title>
                      {commit.sha} · {commit.message} · {commit.author} · {formatDate(commit.date)}
                    </title>
                    <rect
                      x={x - (active ? 4 : 3)}
                      y={layout.mainY - (active ? 4 : 3)}
                      width={active ? 8 : 6}
                      height={active ? 8 : 6}
                      rx={1.5}
                      fill={active ? "var(--primary)" : "var(--muted-foreground)"}
                      stroke="transparent"
                      strokeWidth={2}
                    />
                  </g>
                );
              })}

              {layout.merges.map(({ commit, x }, index) => {
                const showLabel = index % layout.labelEvery === 0;
                const label = commit.prNumber ? `#${commit.prNumber}` : commit.sha;
                return (
                  <g key={commit.fullSha}>
                    <title>
                      {label} · {commit.prTitle ?? commit.subject} · {formatDate(commit.date)}
                    </title>
                    <rect
                      x={x - 4}
                      y={layout.mainY - 4}
                      width={8}
                      height={8}
                      rx={2}
                      fill="var(--background)"
                      stroke="var(--muted-foreground)"
                      strokeWidth={1.5}
                      filter="url(#git-tree-node-shadow)"
                    />
                    {showLabel ? (
                      <>
                        <text
                          x={x}
                          y={layout.mainY + 20}
                          textAnchor="middle"
                          fill="var(--foreground)"
                          fontSize={11}
                          fontWeight={500}
                        >
                          {label}
                        </text>
                        <text
                          x={x}
                          y={layout.mainY + 34}
                          textAnchor="middle"
                          fill="var(--muted-foreground)"
                          fontSize={10}
                        >
                          {compactDate(commit.date)}
                        </text>
                      </>
                    ) : null}
                  </g>
                );
              })}
            </g>
          </g>

          {layout.branches.map(
            ({ branch, forkX, tipX, laneY, path, commitXs, hiddenCommitCount }, index) => {
              const active = activeBranchName === branch.name;
              const dimmed = hasFocus && !active;
              const color = branchColor(branch);
              const branchDelay = MAIN_DRAW_MS + index * BRANCH_STAGGER_MS;
              return (
                <g
                  key={branch.name}
                  data-git-tree-interactive
                  role="button"
                  tabIndex={0}
                  aria-label={branchDescription(branch)}
                  aria-pressed={selectedBranchName === branch.name}
                  className="cursor-pointer outline-none transition-opacity duration-150 ease-in-out focus-visible:[&_path[data-visible]]:stroke-[var(--ring)] motion-reduce:transition-none"
                  opacity={dimmed ? 0.16 : active ? 1 : 0.72}
                  onFocus={() => setFocusedBranchName(branch.name)}
                  onBlur={() => setFocusedBranchName(null)}
                  onMouseEnter={() => setFocusedBranchName(branch.name)}
                  onMouseLeave={() => setFocusedBranchName(null)}
                  onClick={() => activateBranch(branch)}
                  onKeyDown={(event) => handleBranchKeyDown(event, branch)}
                >
                  <title>{branchDescription(branch)}</title>
                  <path d={path} fill="none" stroke="transparent" strokeWidth={18} />
                  <path
                    data-visible
                    d={path}
                    fill="none"
                    stroke={color}
                    strokeWidth={active ? 2.5 : 1.75}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    pathLength={1}
                    className="git-tree-draw-branch"
                    style={{ "--git-tree-delay": `${branchDelay}ms` } as CSSProperties}
                  />
                  <g
                    className="git-tree-fade-info"
                    style={
                      {
                        "--git-tree-delay": `${branchDelay + BRANCH_INFO_OFFSET_MS}ms`,
                      } as CSSProperties
                    }
                  >
                    <rect
                      x={forkX - 3.5}
                      y={layout.mainY - 3.5}
                      width={7}
                      height={7}
                      rx={2}
                      fill="var(--background)"
                      stroke={color}
                      strokeWidth={1.5}
                    />
                    {commitXs.map((x) => (
                      <rect
                        key={`${branch.name}-commit-${x}`}
                        x={x - 2.5}
                        y={laneY - 2.5}
                        width={5}
                        height={5}
                        rx={1}
                        fill={color}
                      />
                    ))}
                    {hiddenCommitCount > 0 ? (
                      <text
                        x={tipX - 7}
                        y={laneY - 8}
                        textAnchor="end"
                        fill="var(--muted-foreground)"
                        fontSize={9}
                      >
                        +{hiddenCommitCount}
                      </text>
                    ) : null}
                    <circle cx={tipX} cy={laneY} r={active ? 5 : 4} fill={color} />
                    <text
                      x={tipX + 10}
                      y={laneY - 3}
                      fill="var(--foreground)"
                      fontSize={11}
                      fontWeight={branch.current ? 700 : 600}
                    >
                      {branch.name.length > 28 ? `${branch.name.slice(0, 27)}…` : branch.name}
                    </text>
                    <text x={tipX + 10} y={laneY + 12} fill="var(--muted-foreground)" fontSize={10}>
                      {branch.ahead > 0 ? `↑${branch.ahead}` : ""}
                      {branch.ahead > 0 && branch.behind > 0 ? "  " : ""}
                      {branch.behind > 0 ? `↓${branch.behind}` : ""}
                      {branch.current ? "  current" : ""}
                    </text>
                  </g>
                </g>
              );
            },
          )}
        </svg>
      </div>

      <div className="pointer-events-none absolute inset-x-3 bottom-3 flex items-end justify-between gap-3">
        <div className="pointer-events-auto min-w-0 max-w-sm rounded-lg border border-border/70 bg-popover/95 px-3 py-2 text-xs shadow-sm backdrop-blur-sm">
          {selectedCommit ? (
            <>
              <div className="truncate font-medium text-foreground">{selectedCommit.message}</div>
              <div className="mt-0.5 text-muted-foreground">
                {selectedCommit.sha} · {selectedCommit.author}
              </div>
              <div className="mt-0.5 text-muted-foreground">{formatDate(selectedCommit.date)}</div>
            </>
          ) : selectedBranch ? (
            <>
              <div className="truncate font-medium text-foreground">{selectedBranch.name}</div>
              <div className="mt-0.5 text-muted-foreground">
                {selectedBranch.ahead} ahead · {selectedBranch.behind} behind ·{" "}
                {selectedBranch.lastCommitAuthor}
              </div>
              <div className="mt-0.5 text-muted-foreground">
                {formatDate(selectedBranch.lastCommitDate)} · {selectedBranch.headSha.slice(0, 8)}
              </div>
            </>
          ) : (
            <span className="text-muted-foreground">
              Drag to pan · Ctrl/⌘ + scroll to zoom · Select a branch for details
            </span>
          )}
        </div>

        <div className="pointer-events-auto flex shrink-0 items-center gap-1 rounded-lg border border-border/70 bg-popover/95 p-1 shadow-sm backdrop-blur-sm">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Zoom out"
            disabled={zoom <= GIT_TREE_ZOOM_MIN}
            onClick={() => requestZoom(zoom - 0.2)}
          >
            <Minus aria-hidden />
          </Button>
          <span className="w-11 text-center text-xs tabular-nums text-muted-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Zoom in"
            disabled={zoom >= GIT_TREE_ZOOM_MAX}
            onClick={() => requestZoom(zoom + 0.2)}
          >
            <Plus aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}
