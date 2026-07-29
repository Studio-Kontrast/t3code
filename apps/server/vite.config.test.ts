import { describe, expect, it } from "vite-plus/test";

import { serverBuildCommand } from "./vite.config.ts";

describe("server build task", () => {
  it("uses the current Node runtime instead of resolving node from PATH", () => {
    expect(serverBuildCommand).toBe(`${JSON.stringify(process.execPath)} "scripts/cli.ts" "build"`);
    expect(serverBuildCommand).not.toMatch(/^node(?:\s|$)/);
  });
});
