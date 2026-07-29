import { defineConfig } from "vite-plus";

import { loadRepoEnv } from "../../scripts/lib/public-config.ts";
import { createNodeRuntimeCommand } from "../../scripts/lib/runtime-command.ts";

const repoEnv = loadRepoEnv();
const shouldLaunchElectronAfterPack = process.env.T3CODE_DESKTOP_DEV === "1";
const buildPreviewAnnotationCssCommand = createNodeRuntimeCommand([
  "scripts/build-preview-annotation-css.mjs",
]);
const devElectronCommand = createNodeRuntimeCommand(["scripts/dev-electron.mjs"]);
const publicConfigDefine = {
  __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify(
    repoEnv.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() ?? "",
  ),
};

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: `${buildPreviewAnnotationCssCommand} && vp pack`,
        dependsOn: ["t3#build"],
        cache: false,
      },
      dev: {
        command: `${buildPreviewAnnotationCssCommand} && cross-env T3CODE_DESKTOP_DEV=1 vp pack --watch`,
        dependsOn: ["t3#build"],
        cache: false,
      },
      "dev:bundle": {
        command: `${buildPreviewAnnotationCssCommand} && vp pack --watch`,
        cache: false,
      },
      "dev:electron": {
        command: devElectronCommand,
        dependsOn: ["t3#build"],
        cache: false,
      },
    },
  },
  pack: [
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      define: publicConfigDefine,
      entry: ["src/main.ts"],
      clean: true,
      deps: {
        alwaysBundle: (id) => id.startsWith("@t3tools/"),
      },
      ...(shouldLaunchElectronAfterPack ? { onSuccess: devElectronCommand } : {}),
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      define: publicConfigDefine,
      entry: ["src/preload.ts"],
      deps: {
        // Sandboxed Electron preloads cannot reliably resolve package imports
        // from inside the packaged ASAR. Bundle Clerk's preload bridge into the
        // preload artifact instead of leaving a runtime require() behind.
        alwaysBundle: (id) => id === "@clerk/electron" || id.startsWith("@clerk/electron/"),
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preview-pick-preload.ts"],
      deps: {
        alwaysBundle: (id) => id === "react-grab" || id.startsWith("react-grab/"),
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preview-pip-preload.ts"],
    },
  ],
});
