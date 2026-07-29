// SPDX-FileCopyrightText: 2026 Block, Inc.
// SPDX-License-Identifier: Apache-2.0
// Adapted from Canopy's components/BranchMap.tsx.

import type { GitTreeBranch, GitTreeDirectCommit, GitTreeMerge } from "@t3tools/contracts";

const LEFT_PADDING = 56;
const RIGHT_PADDING = 136;
const MIN_NODE_SPACING = 42;
const BASE_NODE_SPACING = 124;
const LANE_HEIGHT = 58;
const MAX_LANES = 5;
const CORNER_RADIUS = 18;
const DAY_MS = 86_400_000;
const MIN_COMMIT_SPACING = 14;
const MAX_BRANCH_COMMIT_TICKS = 12;

export const GIT_TREE_ZOOM_MIN = 0.4;
export const GIT_TREE_ZOOM_MAX = 2.4;

export interface GitTreeBranchLayout {
  readonly branch: GitTreeBranch;
  readonly forkX: number;
  readonly tipX: number;
  readonly laneY: number;
  readonly path: string;
  readonly commitXs: readonly number[];
  readonly hiddenCommitCount: number;
}

export interface GitTreeCommitLayout<T> {
  readonly commit: T;
  readonly x: number;
}

export interface GitTreeLayout {
  readonly width: number;
  readonly height: number;
  readonly mainY: number;
  readonly mainStartX: number;
  readonly mainEndX: number;
  readonly labelEvery: number;
  readonly branches: readonly GitTreeBranchLayout[];
  readonly merges: readonly GitTreeCommitLayout<GitTreeMerge>[];
  readonly directCommits: readonly GitTreeCommitLayout<GitTreeDirectCommit>[];
}

interface GitTreeLayoutInput {
  readonly branches: readonly GitTreeBranch[];
  readonly merges: readonly GitTreeMerge[];
  readonly directCommits: readonly GitTreeDirectCommit[];
  readonly defaultBranch: string | null;
  readonly viewportHeight: number;
  readonly zoom: number;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function clampGitTreeZoom(value: number): number {
  return clamp(Math.round(value * 100) / 100, GIT_TREE_ZOOM_MIN, GIT_TREE_ZOOM_MAX);
}

/**
 * Builds stable SVG geometry independently of React so large repositories can
 * be covered with deterministic unit tests.
 */
export function buildGitTreeLayout(input: GitTreeLayoutInput): GitTreeLayout {
  const zoom = clampGitTreeZoom(input.zoom);
  const nodeSpacing = Math.max(MIN_NODE_SPACING, Math.round(BASE_NODE_SPACING * zoom));
  const merges = [...input.merges].sort(
    (left, right) =>
      timestamp(left.date) - timestamp(right.date) || left.fullSha.localeCompare(right.fullSha),
  );
  const directCommits = [...input.directCommits].sort(
    (left, right) =>
      timestamp(left.date) - timestamp(right.date) || left.fullSha.localeCompare(right.fullSha),
  );
  const anchors = merges.length > 0 ? merges : directCommits;
  const visibleBranches = input.branches
    .filter((branch) => branch.name !== input.defaultBranch)
    .sort((left, right) => timestamp(right.lastCommitDate) - timestamp(left.lastCommitDate));

  const firstAnchorTime = anchors[0] ? timestamp(anchors[0].date) : Date.now();
  const lastAnchorTime = anchors.at(-1) ? timestamp(anchors.at(-1)!.date) : firstAnchorTime + 1;
  const anchorSpan = Math.max(1, lastAnchorTime - firstAnchorTime);
  const averageAnchorInterval = anchors.length > 1 ? anchorSpan / (anchors.length - 1) : 7 * DAY_MS;
  const extrapolatedPixelsPerMs = nodeSpacing / Math.max(averageAnchorInterval, 7 * DAY_MS);
  const anchorEndX = LEFT_PADDING + Math.max(anchors.length - 1, 0) * nodeSpacing;

  const rawTimeToX = (date: string): number => {
    if (anchors.length === 0) return LEFT_PADDING;
    const time = timestamp(date);
    for (let index = 0; index < anchors.length - 1; index += 1) {
      const left = anchors[index];
      const right = anchors[index + 1];
      if (!left || !right) continue;
      const leftTime = timestamp(left.date);
      const rightTime = timestamp(right.date);
      if (time < leftTime || time > rightTime) continue;
      const interval = Math.max(1, rightTime - leftTime);
      return LEFT_PADDING + (index + (time - leftTime) / interval) * nodeSpacing;
    }
    if (time < firstAnchorTime) {
      return LEFT_PADDING + (time - firstAnchorTime) * extrapolatedPixelsPerMs;
    }
    return anchorEndX + (time - lastAnchorTime) * extrapolatedPixelsPerMs;
  };

  const timelineEvents = [
    ...merges.map((commit) => ({ kind: "merge" as const, commit })),
    ...directCommits.map((commit) => ({ kind: "direct" as const, commit })),
  ].sort(
    (left, right) =>
      timestamp(left.commit.date) - timestamp(right.commit.date) ||
      left.commit.fullSha.localeCompare(right.commit.fullSha) ||
      left.kind.localeCompare(right.kind),
  );
  const eventKey = (kind: "merge" | "direct", fullSha: string): string => `${kind}:${fullSha}`;
  const unshiftedEventX = new Map<string, number>();
  let previousEventX = Number.NEGATIVE_INFINITY;
  for (const event of timelineEvents) {
    const baseX = rawTimeToX(event.commit.date);
    const x = Number.isFinite(previousEventX)
      ? Math.max(baseX, previousEventX + MIN_COMMIT_SPACING)
      : baseX;
    unshiftedEventX.set(eventKey(event.kind, event.commit.fullSha), x);
    previousEventX = x;
  }

  const timestampGroups: Array<{
    readonly time: number;
    startX: number;
    endX: number;
  }> = [];
  for (const event of timelineEvents) {
    const time = timestamp(event.commit.date);
    const x = unshiftedEventX.get(eventKey(event.kind, event.commit.fullSha)) ?? LEFT_PADDING;
    const current = timestampGroups.at(-1);
    if (current?.time === time) {
      current.endX = x;
    } else {
      timestampGroups.push({ time, startX: x, endX: x });
    }
  }

  const unshiftedTimeToX = (date: string): number => {
    const time = timestamp(date);
    const first = timestampGroups[0];
    const last = timestampGroups.at(-1);
    if (!first || !last) return LEFT_PADDING;
    const center = (group: (typeof timestampGroups)[number]): number =>
      (group.startX + group.endX) / 2;
    if (time <= first.time) {
      return center(first) + (time - first.time) * extrapolatedPixelsPerMs;
    }
    for (let index = 0; index < timestampGroups.length - 1; index += 1) {
      const left = timestampGroups[index];
      const right = timestampGroups[index + 1];
      if (!left || !right || time > right.time) continue;
      const ratio = (time - left.time) / Math.max(1, right.time - left.time);
      return center(left) + ratio * (center(right) - center(left));
    }
    return center(last) + (time - last.time) * extrapolatedPixelsPerMs;
  };

  const extentDates = visibleBranches.flatMap((branch) => [
    branch.divergedFromDate ?? branch.lastCommitDate,
    branch.lastCommitDate,
  ]);
  const minimumUnshiftedX = Math.min(
    LEFT_PADDING,
    ...unshiftedEventX.values(),
    ...extentDates.map((date) => unshiftedTimeToX(date)),
  );
  const xOffset = Math.max(0, LEFT_PADDING - minimumUnshiftedX);
  const timeToX = (date: string): number => unshiftedTimeToX(date) + xOffset;
  const eventX = (kind: "merge" | "direct", fullSha: string): number =>
    (unshiftedEventX.get(eventKey(kind, fullSha)) ?? LEFT_PADDING) + xOffset;
  const firstTimelineEvent = timelineEvents[0];
  const lastTimelineEvent = timelineEvents.at(-1);
  const mainStartX = firstTimelineEvent
    ? eventX(firstTimelineEvent.kind, firstTimelineEvent.commit.fullSha)
    : LEFT_PADDING;
  const mainEndX = lastTimelineEvent
    ? eventX(lastTimelineEvent.kind, lastTimelineEvent.commit.fullSha)
    : mainStartX;

  const laneCount = Math.max(1, Math.min(MAX_LANES, visibleBranches.length));
  const minimumMainY = 72 + laneCount * LANE_HEIGHT;
  const mainY = Math.max(minimumMainY, input.viewportHeight - 104);

  const branchesByFork = [...visibleBranches].sort((left, right) => {
    const leftDate = left.divergedFromDate ?? left.lastCommitDate;
    const rightDate = right.divergedFromDate ?? right.lastCommitDate;
    return timeToX(leftDate) - timeToX(rightDate);
  });
  const laneByBranch = new Map<string, number>();
  branchesByFork.forEach((branch, index) => laneByBranch.set(branch.name, index % laneCount));

  let furthestX = mainEndX;
  const branchLayouts = visibleBranches.map((branch): GitTreeBranchLayout => {
    const forkX = timeToX(branch.divergedFromDate ?? branch.lastCommitDate);
    const naturalTipX = timeToX(branch.lastCommitDate);
    const tipX = Math.max(naturalTipX, forkX + CORNER_RADIUS * 2 + 36);
    const laneY = mainY - ((laneByBranch.get(branch.name) ?? 0) + 1) * LANE_HEIGHT;
    furthestX = Math.max(furthestX, tipX + 96);
    const path = [
      `M ${forkX} ${mainY}`,
      `L ${forkX} ${laneY + CORNER_RADIUS}`,
      `Q ${forkX} ${laneY} ${forkX + CORNER_RADIUS} ${laneY}`,
      `L ${tipX} ${laneY}`,
    ].join(" ");
    const commitSpanStart = forkX + CORNER_RADIUS;
    const commitSpan = Math.max(0, tipX - commitSpanStart);
    const commitsThatFit = Math.max(0, Math.floor(commitSpan / MIN_COMMIT_SPACING) - 1);
    const visibleCommitCount = Math.min(branch.ahead, MAX_BRANCH_COMMIT_TICKS, commitsThatFit);
    const commitXs = Array.from(
      { length: visibleCommitCount },
      (_, index) => commitSpanStart + (commitSpan * (index + 1)) / (visibleCommitCount + 1),
    );
    return {
      branch,
      forkX,
      tipX,
      laneY,
      path,
      commitXs,
      hiddenCommitCount: Math.max(0, branch.ahead - visibleCommitCount),
    };
  });

  const width = Math.max(LEFT_PADDING + RIGHT_PADDING + 240, furthestX + RIGHT_PADDING);
  const height = Math.max(input.viewportHeight, mainY + 96);
  const labelEvery = Math.max(1, Math.ceil(96 / nodeSpacing));

  return {
    width,
    height,
    mainY,
    mainStartX,
    mainEndX,
    labelEvery,
    branches: branchLayouts,
    merges: merges.map((commit) => ({ commit, x: eventX("merge", commit.fullSha) })),
    directCommits: directCommits.map((commit) => ({
      commit,
      x: eventX("direct", commit.fullSha),
    })),
  };
}
