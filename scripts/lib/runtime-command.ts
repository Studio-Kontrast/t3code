/**
 * Build a shell command that reuses the Node runtime currently executing the
 * Vite+ config. This avoids resolving an unrelated `node` shim from PATH in
 * nested workspace tasks.
 */
export function createNodeRuntimeCommand(
  args: ReadonlyArray<string>,
  nodeExecutable = process.execPath,
): string {
  return [nodeExecutable, ...args].map((argument) => JSON.stringify(argument)).join(" ");
}
