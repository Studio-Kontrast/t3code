import * as NodeURL from "node:url";

export function resolveServerBundleRuntimeCommand(
  nodeExecutable = process.execPath,
  vitePlusCliUrl = import.meta.resolve("vite-plus/bin"),
): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
} {
  return {
    command: nodeExecutable,
    args: [NodeURL.fileURLToPath(vitePlusCliUrl), "pack"],
  };
}
