// SPDX-FileCopyrightText: 2026 Block, Inc.
// SPDX-License-Identifier: Apache-2.0
// Adapted from Canopy's components/BranchMap.tsx at 8bc295dc1a210fbb648f4cf42203ae5d2c4c9478.

import type { GitTreeBranch, GitTreeSnapshotResult } from "@t3tools/contracts";
import { Minus, Plus } from "lucide-react";
import {
  type CSSProperties,
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
  gitTreeCommitHitWidth,
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

type GitTreeTarget =
  | { readonly kind: "branch"; readonly name: string }
  | { readonly kind: "direct"; readonly sha: string }
  | { readonly kind: "merge"; readonly sha: string };

interface GitTreeTooltipContent {
  readonly x: number;
  readonly y: number;
  readonly markerColor?: string;
  readonly title: string;
  readonly meta: string;
  readonly detail: string;
}

const MAIN_DRAW_MS = 1_200;
const BRANCH_STAGGER_MS = 60;
const BRANCH_INFO_OFFSET_MS = 750;
const TOOLTIP_WIDTH = 248;
const TOOLTIP_HEIGHT = 68;
const TOOLTIP_GAP = 18;
const TOOLTIP_WARM_WINDOW_MS = 400;

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

function GitTreeTooltip({
  content,
  layoutWidth,
  instant,
}: {
  readonly content: GitTreeTooltipContent;
  readonly layoutWidth: number;
  readonly instant: boolean;
}) {
  const left = Math.min(
    Math.max(content.x - TOOLTIP_WIDTH / 2, 8),
    layoutWidth - TOOLTIP_WIDTH - 8,
  );
  const top = Math.max(8, content.y - TOOLTIP_HEIGHT - TOOLTIP_GAP);

  return (
    <div
      className="git-tree-tooltip-positioner pointer-events-none absolute top-0 left-0 z-10"
      style={{
        width: TOOLTIP_WIDTH,
        height: TOOLTIP_HEIGHT,
        transform: `translate3d(${left}px, ${top}px, 0)`,
      }}
      aria-hidden
    >
      <div
        data-instant={instant || undefined}
        className="git-tree-tooltip-card h-full rounded-lg border border-border/70 bg-popover/95 px-3 py-2 text-xs shadow-md backdrop-blur-sm"
        style={
          {
            "--git-tree-tooltip-arrow-x": `${content.x - left}px`,
          } as CSSProperties
        }
      >
        <div className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
          {content.markerColor ? (
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: content.markerColor }}
            />
          ) : null}
          <span className="truncate">{content.title}</span>
        </div>
        <div className="mt-0.5 truncate text-muted-foreground">{content.meta}</div>
        <div className="mt-0.5 truncate text-muted-foreground">{content.detail}</div>
      </div>
    </div>
  );
}

export function GitTreeMap({ snapshot }: GitTreeMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const zoomAnchorRef = useRef<ZoomAnchor | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const pendingZoomRef = useRef<number | null>(null);
  const tooltipWarmRef = useRef(false);
  const tooltipWarmTimeoutRef = useRef<number | null>(null);
  const [viewportHeight, setViewportHeight] = useState(420);
  const [zoom, setZoom] = useState(1);
  const [hoveredTarget, setHoveredTarget] = useState<GitTreeTarget | null>(null);
  const [focusedTarget, setFocusedTarget] = useState<GitTreeTarget | null>(null);
  const [displayedTarget, setDisplayedTarget] = useState<GitTreeTarget | null>(null);
  const [tooltipInstant, setTooltipInstant] = useState(false);
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
  const commitHitWidths = useMemo(() => {
    const marks = [
      ...layout.directCommits.map(({ commit, x }) => ({
        key: `direct:${commit.fullSha}`,
        x,
      })),
      ...layout.merges.map(({ commit, x }) => ({ key: `merge:${commit.fullSha}`, x })),
    ].sort((left, right) => left.x - right.x || left.key.localeCompare(right.key));

    return new Map(
      marks.map((mark, index) => [
        mark.key,
        gitTreeCommitHitWidth(mark.x, marks[index - 1]?.x, marks[index + 1]?.x),
      ]),
    );
  }, [layout.directCommits, layout.merges]);

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
      if (tooltipWarmTimeoutRef.current !== null) {
        window.clearTimeout(tooltipWarmTimeoutRef.current);
      }
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

  const cancelTooltipHide = useCallback(() => {
    if (tooltipWarmTimeoutRef.current === null) return;
    window.clearTimeout(tooltipWarmTimeoutRef.current);
    tooltipWarmTimeoutRef.current = null;
  }, []);

  const scheduleTooltipHide = useCallback(() => {
    cancelTooltipHide();
    tooltipWarmTimeoutRef.current = window.setTimeout(() => {
      tooltipWarmRef.current = false;
      tooltipWarmTimeoutRef.current = null;
      setDisplayedTarget(null);
    }, TOOLTIP_WARM_WINDOW_MS);
  }, [cancelTooltipHide]);

  const showHoveredTooltip = useCallback(
    (target: GitTreeTarget) => {
      cancelTooltipHide();
      setTooltipInstant(tooltipWarmRef.current);
      tooltipWarmRef.current = true;
      setHoveredTarget(target);
      setDisplayedTarget(target);
    },
    [cancelTooltipHide],
  );

  const hideHoveredTooltip = useCallback(() => {
    setHoveredTarget(null);
    if (focusedTarget === null) scheduleTooltipHide();
  }, [focusedTarget, scheduleTooltipHide]);

  const showFocusedTooltip = useCallback(
    (target: GitTreeTarget) => {
      cancelTooltipHide();
      tooltipWarmRef.current = true;
      setTooltipInstant(true);
      setFocusedTarget(target);
      setDisplayedTarget(target);
    },
    [cancelTooltipHide],
  );

  const hideFocusedTooltip = useCallback(() => {
    setFocusedTarget(null);
    if (hoveredTarget === null) scheduleTooltipHide();
  }, [hoveredTarget, scheduleTooltipHide]);

  const activeTarget = hoveredTarget ?? focusedTarget;
  const activeBranchName = activeTarget?.kind === "branch" ? activeTarget.name : null;
  const hasFocus = activeBranchName !== null;
  const tooltipContent = useMemo((): GitTreeTooltipContent | null => {
    if (!displayedTarget) return null;
    if (displayedTarget.kind === "branch") {
      const item = layout.branches.find(({ branch }) => branch.name === displayedTarget.name);
      if (!item) return null;
      return {
        x: item.tipX,
        y: item.laneY,
        markerColor: branchColor(item.branch),
        title: item.branch.name,
        meta: `${item.branch.ahead} ahead · ${item.branch.behind} behind · ${item.branch.lastCommitAuthor}`,
        detail: `${formatDate(item.branch.lastCommitDate)} · ${item.branch.headSha.slice(0, 8)}`,
      };
    }
    if (displayedTarget.kind === "direct") {
      const item = layout.directCommits.find(
        ({ commit }) => commit.fullSha === displayedTarget.sha,
      );
      if (!item) return null;
      return {
        x: item.x,
        y: layout.mainY,
        title: item.commit.message,
        meta: `${item.commit.sha} · ${item.commit.author}`,
        detail: formatDate(item.commit.date),
      };
    }
    const item = layout.merges.find(({ commit }) => commit.fullSha === displayedTarget.sha);
    if (!item) return null;
    return {
      x: item.x,
      y: layout.mainY,
      title: item.commit.prTitle ?? item.commit.subject,
      meta: `${item.commit.prNumber ? `#${item.commit.prNumber}` : item.commit.sha} · merge commit`,
      detail: formatDate(item.commit.date),
    };
  }, [displayedTarget, layout]);
  const defaultBranchLabel = snapshot.defaultBranch ?? snapshot.currentBranch ?? "HEAD";

  return (
    <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden bg-background">
      <div
        ref={scrollRef}
        className={cn(
          "size-full touch-pan-y select-none overflow-x-auto overflow-y-hidden overscroll-contain",
          isPanning ? "cursor-grabbing" : "cursor-grab",
        )}
        role="region"
        aria-label="Git history visualization. Drag horizontally to pan and hold Control while scrolling to zoom."
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPanning}
        onPointerCancel={finishPanning}
      >
        <div className="relative shrink-0" style={{ width: layout.width, height: layout.height }}>
          <svg
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className={cn("block max-w-none", drawReady && "git-tree-timeline-ready")}
            role="group"
            aria-labelledby="git-tree-map-title git-tree-map-description"
          >
            <title id="git-tree-map-title">{`Git history for ${snapshot.name}`}</title>
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
                  const target = { kind: "direct", sha: commit.fullSha } as const;
                  const active =
                    activeTarget?.kind === "direct" && activeTarget.sha === commit.fullSha;
                  return (
                    <g
                      key={commit.fullSha}
                      data-git-tree-interactive
                      role="group"
                      tabIndex={0}
                      aria-label={`${commit.sha}, ${commit.message}, by ${commit.author} on ${formatDate(commit.date)}`}
                      className="cursor-help outline-none focus-visible:[&_[data-visible-node]]:stroke-[var(--ring)]"
                      onFocus={() => showFocusedTooltip(target)}
                      onBlur={hideFocusedTooltip}
                      onMouseEnter={() => showHoveredTooltip(target)}
                      onMouseLeave={hideHoveredTooltip}
                    >
                      <rect
                        data-hit-area
                        x={x - (commitHitWidths.get(`direct:${commit.fullSha}`) ?? 20) / 2}
                        y={layout.mainY - 10}
                        width={commitHitWidths.get(`direct:${commit.fullSha}`) ?? 20}
                        height={20}
                        fill="transparent"
                      />
                      <rect
                        data-visible-node
                        x={x - (active ? 4 : 3)}
                        y={layout.mainY - (active ? 4 : 3)}
                        width={active ? 8 : 6}
                        height={active ? 8 : 6}
                        rx={1.5}
                        fill={active ? "var(--primary)" : "var(--muted-foreground)"}
                        stroke="transparent"
                        strokeWidth={2}
                        pointerEvents="none"
                      />
                    </g>
                  );
                })}

                {layout.merges.map(({ commit, x }, index) => {
                  const showLabel = index % layout.labelEvery === 0;
                  const label = commit.prNumber ? `#${commit.prNumber}` : commit.sha;
                  const target = { kind: "merge", sha: commit.fullSha } as const;
                  const active =
                    activeTarget?.kind === "merge" && activeTarget.sha === commit.fullSha;
                  return (
                    <g
                      key={commit.fullSha}
                      data-git-tree-interactive
                      role="group"
                      tabIndex={0}
                      aria-label={`${label}, ${commit.prTitle ?? commit.subject}, on ${formatDate(commit.date)}`}
                      className="cursor-help outline-none focus-visible:[&_[data-visible-node]]:stroke-[var(--ring)]"
                      onFocus={() => showFocusedTooltip(target)}
                      onBlur={hideFocusedTooltip}
                      onMouseEnter={() => showHoveredTooltip(target)}
                      onMouseLeave={hideHoveredTooltip}
                    >
                      <rect
                        data-hit-area
                        x={x - (commitHitWidths.get(`merge:${commit.fullSha}`) ?? 20) / 2}
                        y={layout.mainY - 10}
                        width={commitHitWidths.get(`merge:${commit.fullSha}`) ?? 20}
                        height={20}
                        fill="transparent"
                      />
                      <rect
                        data-visible-node
                        x={x - (active ? 5 : 4)}
                        y={layout.mainY - (active ? 5 : 4)}
                        width={active ? 10 : 8}
                        height={active ? 10 : 8}
                        rx={2}
                        fill="var(--background)"
                        stroke="var(--muted-foreground)"
                        strokeWidth={1.5}
                        filter="url(#git-tree-node-shadow)"
                        pointerEvents="none"
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
                const target = { kind: "branch", name: branch.name } as const;
                return (
                  <g
                    key={branch.name}
                    data-git-tree-interactive
                    role="group"
                    tabIndex={0}
                    aria-label={branchDescription(branch)}
                    className="cursor-help outline-none transition-opacity duration-150 ease-in-out focus-visible:[&_path[data-visible]]:stroke-[var(--ring)] motion-reduce:transition-none"
                    opacity={dimmed ? 0.16 : active ? 1 : 0.72}
                    onFocus={() => showFocusedTooltip(target)}
                    onBlur={hideFocusedTooltip}
                    onMouseEnter={() => showHoveredTooltip(target)}
                    onMouseLeave={hideHoveredTooltip}
                  >
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
                      <text
                        x={tipX + 10}
                        y={laneY + 12}
                        fill="var(--muted-foreground)"
                        fontSize={10}
                      >
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

          {tooltipContent ? (
            <GitTreeTooltip
              content={tooltipContent}
              layoutWidth={layout.width}
              instant={tooltipInstant}
            />
          ) : null}
        </div>
      </div>

      <div className="pointer-events-none absolute right-3 bottom-3">
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
