import type { GitTreeBranch, GitTreeDirectCommit, GitTreeMerge } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildGitTreeLayout,
  clampGitTreeZoom,
  GIT_TREE_ZOOM_MAX,
  GIT_TREE_ZOOM_MIN,
} from "./gitTreeLayout";

const merge = (sha: string, date: string): GitTreeMerge => ({
  fullSha: sha.repeat(40).slice(0, 40),
  sha,
  subject: `Merge ${sha}`,
  date,
  prNumber: null,
  prTitle: null,
});

const directCommit = (sha: string, date: string): GitTreeDirectCommit => ({
  fullSha: sha.repeat(40).slice(0, 40),
  sha,
  message: `Commit ${sha}`,
  author: "Ada",
  date,
});

const branch = (name: string, date: string, divergedFromDate: string): GitTreeBranch => ({
  name,
  current: false,
  ahead: 2,
  behind: 1,
  headSha: name.repeat(40).slice(0, 40),
  lastCommitDate: date,
  lastCommitAuthor: "Ada",
  divergedFromSha: null,
  divergedFromDate,
  status: "fresh",
});

describe("gitTreeLayout", () => {
  it("clamps zoom to the supported range", () => {
    expect(clampGitTreeZoom(0.01)).toBe(GIT_TREE_ZOOM_MIN);
    expect(clampGitTreeZoom(10)).toBe(GIT_TREE_ZOOM_MAX);
  });

  it("orders main-line commits chronologically and excludes the default branch arc", () => {
    const layout = buildGitTreeLayout({
      branches: [
        branch("main", "2026-01-03T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
        branch("feature", "2026-01-04T00:00:00.000Z", "2026-01-02T00:00:00.000Z"),
      ],
      merges: [
        merge("ccc3333", "2026-01-03T00:00:00.000Z"),
        merge("aaa1111", "2026-01-01T00:00:00.000Z"),
      ],
      directCommits: [directCommit("bbb2222", "2026-01-02T00:00:00.000Z")],
      defaultBranch: "main",
      viewportHeight: 500,
      zoom: 1,
    });

    expect(layout.merges.map(({ commit }) => commit.sha)).toEqual(["aaa1111", "ccc3333"]);
    expect(layout.merges[0]!.x).toBeLessThan(layout.merges[1]!.x);
    expect(layout.branches.map(({ branch: item }) => item.name)).toEqual(["feature"]);
    expect(layout.branches[0]!.tipX).toBeGreaterThan(layout.branches[0]!.forkX);
  });

  it("uses direct commits as timeline anchors when there are no merges", () => {
    const layout = buildGitTreeLayout({
      branches: [],
      merges: [],
      directCommits: [
        directCommit("aaa1111", "2026-01-01T00:00:00.000Z"),
        directCommit("bbb2222", "2026-01-02T00:00:00.000Z"),
      ],
      defaultBranch: "main",
      viewportHeight: 320,
      zoom: 1,
    });

    expect(layout.mainEndX).toBeGreaterThan(layout.mainStartX);
    expect(layout.directCommits[0]!.x).toBe(layout.mainStartX);
    expect(layout.directCommits[1]!.x).toBe(layout.mainEndX);
  });

  it("covers direct commits before and after the merge anchor range", () => {
    const layout = buildGitTreeLayout({
      branches: [],
      merges: [
        merge("bbb2222", "2026-01-10T00:00:00.000Z"),
        merge("ccc3333", "2026-01-20T00:00:00.000Z"),
      ],
      directCommits: [
        directCommit("aaa1111", "2026-01-01T00:00:00.000Z"),
        directCommit("ddd4444", "2026-02-01T00:00:00.000Z"),
      ],
      defaultBranch: "main",
      viewportHeight: 320,
      zoom: 1,
    });

    expect(layout.directCommits[0]!.x).toBe(layout.mainStartX);
    expect(layout.directCommits[1]!.x).toBe(layout.mainEndX);
    expect(layout.mainStartX).toBeGreaterThanOrEqual(0);
    expect(layout.mainEndX).toBeLessThan(layout.width);
    expect(layout.merges[0]!.x).toBeGreaterThan(layout.mainStartX);
    expect(layout.merges[1]!.x).toBeLessThan(layout.mainEndX);
  });

  it("gives commits with identical timestamps stable distinct positions", () => {
    const date = "2026-01-10T00:00:00.000Z";
    const input = {
      branches: [],
      merges: [merge("ccc3333", date), merge("aaa1111", date)],
      directCommits: [directCommit("bbb2222", date), directCommit("ddd4444", date)],
      defaultBranch: "main",
      viewportHeight: 320,
      zoom: 1,
    } as const;

    const layout = buildGitTreeLayout(input);
    const reversed = buildGitTreeLayout({
      ...input,
      merges: input.merges.toReversed(),
      directCommits: input.directCommits.toReversed(),
    });
    const positions = [...layout.merges, ...layout.directCommits].map(({ x }) => x);
    const positionsBySha = (value: typeof layout) =>
      Object.fromEntries(
        [...value.merges, ...value.directCommits].map(({ commit, x }) => [commit.fullSha, x]),
      );

    expect(new Set(positions).size).toBe(positions.length);
    const sortedPositions = positions.toSorted((left, right) => left - right);
    expect(
      sortedPositions.slice(1).every((position, index) => position - sortedPositions[index]! >= 18),
    ).toBe(true);
    expect(Math.min(...positions)).toBe(layout.mainStartX);
    expect(Math.max(...positions)).toBe(layout.mainEndX);
    expect(positions.every((x) => x >= 0 && x < layout.width)).toBe(true);
    expect(positionsBySha(reversed)).toEqual(positionsBySha(layout));
  });

  it("assigns overlapping branch arcs to several vertical lanes", () => {
    const layout = buildGitTreeLayout({
      branches: [
        branch("one", "2026-01-03T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
        branch("two", "2026-01-04T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
        branch("three", "2026-01-05T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
      ],
      merges: [
        merge("aaa1111", "2026-01-01T00:00:00.000Z"),
        merge("bbb2222", "2026-01-05T00:00:00.000Z"),
      ],
      directCommits: [],
      defaultBranch: "main",
      viewportHeight: 420,
      zoom: 1,
    });

    expect(new Set(layout.branches.map((item) => item.laneY)).size).toBe(3);
  });

  it("places ahead commits on branch arcs without overflowing the tip", () => {
    const feature = {
      ...branch("feature", "2026-01-05T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
      ahead: 20,
    };
    const layout = buildGitTreeLayout({
      branches: [feature],
      merges: [
        merge("aaa1111", "2026-01-01T00:00:00.000Z"),
        merge("bbb2222", "2026-01-05T00:00:00.000Z"),
      ],
      directCommits: [],
      defaultBranch: "main",
      viewportHeight: 420,
      zoom: 1,
    });

    const featureLayout = layout.branches[0]!;
    expect(featureLayout.commitXs.length).toBeGreaterThan(0);
    expect(featureLayout.commitXs.length).toBeLessThanOrEqual(12);
    expect(featureLayout.hiddenCommitCount + featureLayout.commitXs.length).toBe(feature.ahead);
    expect(featureLayout.commitXs.every((x) => x > featureLayout.forkX)).toBe(true);
    expect(featureLayout.commitXs.every((x) => x < featureLayout.tipX)).toBe(true);
  });
});
