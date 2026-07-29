import type { GitTreeSnapshotResult, VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hasGitTreeActivity, shouldRefreshGitTreeForVcsChange } from "./GitTreePanel";

const status = { isRepo: true } as VcsStatusResult;

describe("shouldRefreshGitTreeForVcsChange", () => {
  it("refreshes only after an already observed VCS snapshot changes", () => {
    const nextStatus = { ...status };

    expect(shouldRefreshGitTreeForVcsChange(null, status)).toBe(false);
    expect(shouldRefreshGitTreeForVcsChange(status, status)).toBe(false);
    expect(shouldRefreshGitTreeForVcsChange(status, nextStatus)).toBe(true);
    expect(shouldRefreshGitTreeForVcsChange(status, null)).toBe(false);
  });
});

describe("hasGitTreeActivity", () => {
  const snapshot = {
    _tag: "repository",
    requestedCwd: "/workspace/t3code",
    root: "/workspace/t3code",
    name: "t3code",
    currentBranch: "main",
    defaultBranch: "main",
    isEmpty: false,
    branches: [],
    merges: [],
    directCommits: [],
    truncated: { branches: false, merges: false, directCommits: false },
  } satisfies Extract<GitTreeSnapshotResult, { _tag: "repository" }>;

  it("treats an empty history payload as inactive", () => {
    expect(hasGitTreeActivity(snapshot)).toBe(false);
  });

  it("treats either direct or merge commits as activity", () => {
    expect(
      hasGitTreeActivity({
        ...snapshot,
        directCommits: [
          {
            fullSha: "1111111111111111111111111111111111111111",
            sha: "1111111",
            message: "Initial commit",
            author: "Ada",
            date: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    ).toBe(true);
    expect(
      hasGitTreeActivity({
        ...snapshot,
        merges: [
          {
            fullSha: "2222222222222222222222222222222222222222",
            sha: "2222222",
            subject: "Merge feature",
            date: "2026-01-02T00:00:00.000Z",
            prNumber: 42,
            prTitle: "Feature",
          },
        ],
      }),
    ).toBe(true);
  });
});
