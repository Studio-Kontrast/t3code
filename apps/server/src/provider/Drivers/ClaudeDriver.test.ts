// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { resolveClaudeRuntimeSettings } from "./ClaudeDriver.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it.layer(NodeServices.layer)("resolveClaudeRuntimeSettings", (it) => {
  it.effect("resolves a PATH command to the executable used by every Claude runtime", () =>
    Effect.gen(function* () {
      const executableName = NodePath.basename(process.execPath);
      const executableDirectory = NodePath.dirname(process.execPath);
      const settings = decodeClaudeSettings({ binaryPath: executableName });

      const resolved = yield* resolveClaudeRuntimeSettings(settings, {
        PATH: executableDirectory,
        PATHEXT: process.env.PATHEXT,
      });

      assert.strictEqual(resolved.binaryPath, process.execPath);
    }),
  );

  it.effect("keeps the configured command when lookup fails", () =>
    Effect.gen(function* () {
      const settings = decodeClaudeSettings({ binaryPath: "missing-claude-command" });
      const resolved = yield* resolveClaudeRuntimeSettings(settings, { PATH: "" });

      assert.strictEqual(resolved.binaryPath, "missing-claude-command");
    }),
  );
});
