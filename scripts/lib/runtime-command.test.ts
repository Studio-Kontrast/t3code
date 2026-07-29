import { describe, expect, it } from "vite-plus/test";

import { createNodeRuntimeCommand } from "./runtime-command.ts";

describe("createNodeRuntimeCommand", () => {
  it("pins nested tasks to the selected Node runtime", () => {
    expect(
      createNodeRuntimeCommand(["scripts/cli.ts", "build"], "/managed runtimes/node-v24"),
    ).toBe('"/managed runtimes/node-v24" "scripts/cli.ts" "build"');
  });

  it("uses the current executable instead of resolving node from PATH", () => {
    const command = createNodeRuntimeCommand(["scripts/cli.ts", "build"]);

    expect(command).toBe(`${JSON.stringify(process.execPath)} "scripts/cli.ts" "build"`);
    expect(command).not.toMatch(/^node(?:\s|$)/);
  });
});
