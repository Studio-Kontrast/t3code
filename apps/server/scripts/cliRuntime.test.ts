import { assert, it } from "@effect/vitest";

import { resolveServerBundleRuntimeCommand } from "./cliRuntime.ts";

it("pins the server bundle to the current Node runtime", () => {
  const command = resolveServerBundleRuntimeCommand();

  assert.equal(command.command, process.execPath);
  assert.deepEqual(command.args.slice(1), ["pack"]);
  assert.match(command.args[0] ?? "", /vite-plus[/\\]dist[/\\]bin\.js$/);
  assert.notEqual(command.command, "node");
});
