import type { GitTreeSnapshotResult } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { GitTreeMap } from "./GitTreeMap";

const snapshot: Extract<GitTreeSnapshotResult, { _tag: "repository" }> = {
  _tag: "repository",
  requestedCwd: "/workspace/t3code",
  root: "/workspace/t3code",
  name: "t3code",
  currentBranch: "feature/accessibility",
  defaultBranch: "main",
  isEmpty: false,
  branches: [
    {
      name: "main",
      current: false,
      ahead: 0,
      behind: 0,
      headSha: "1111111111111111111111111111111111111111",
      lastCommitDate: "2026-01-01T00:00:00.000Z",
      lastCommitAuthor: "Ada",
      divergedFromSha: null,
      divergedFromDate: null,
      status: "fresh",
    },
    {
      name: "feature/accessibility",
      current: true,
      ahead: 1,
      behind: 0,
      headSha: "2222222222222222222222222222222222222222",
      lastCommitDate: "2026-01-02T00:00:00.000Z",
      lastCommitAuthor: "Grace",
      divergedFromSha: "1111111111111111111111111111111111111111",
      divergedFromDate: "2026-01-01T00:00:00.000Z",
      status: "fresh",
    },
  ],
  merges: [],
  directCommits: [
    {
      fullSha: "1111111111111111111111111111111111111111",
      sha: "1111111",
      message: "Initial commit",
      author: "Ada",
      date: "2026-01-01T00:00:00.000Z",
    },
  ],
  truncated: { branches: false, merges: false, directCommits: false },
};

describe("GitTreeMap accessibility", () => {
  it("keeps keyboard branch controls exposed below the SVG group", () => {
    const markup = renderToStaticMarkup(<GitTreeMap snapshot={snapshot} />);

    expect(markup).toMatch(/<svg[^>]*role="group"/);
    expect(markup).not.toContain('role="img"');
    expect(markup).toMatch(/<g[^>]*role="button"[^>]*tabindex="0"/);
    expect(markup).toContain('aria-label="feature/accessibility, 1 ahead');
    expect(markup).toContain('aria-label="1111111, Initial commit, by Ada');
  });
});
