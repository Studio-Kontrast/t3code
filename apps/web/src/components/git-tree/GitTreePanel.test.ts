import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldRefreshGitTreeForVcsChange } from "./GitTreePanel";

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
