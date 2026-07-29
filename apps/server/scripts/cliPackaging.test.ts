import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  CLI_DISTRIBUTION_NOTICE_ASSETS,
  copyCliDistributionNotices,
  DISTRIBUTION_APACHE_LICENSE_LINK,
} from "./cliPackaging.ts";

it.layer(NodeServices.layer)("CLI distribution notices", (it) => {
  it.effect("packages a resolvable notice link and the exact Apache license", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("../../..", import.meta.url));
      const serverDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-cli-packaging-",
      });

      const copiedTargets = yield* copyCliDistributionNotices(repoRoot, serverDir);

      assert.deepEqual(
        copiedTargets,
        CLI_DISTRIBUTION_NOTICE_ASSETS.map((asset) =>
          path.join(serverDir, asset.targetRelativePath),
        ),
      );

      const packagedNoticePath = path.join(serverDir, "dist/THIRD_PARTY_NOTICES.md");
      const packagedNotice = yield* fs.readFileString(packagedNoticePath);
      const packagedLicenseLink =
        packagedNotice.match(/\[`LICENSES\/Apache-2\.0\.txt`\]\(([^)]+)\)/)?.[1] ?? "";
      assert.equal(packagedLicenseLink, DISTRIBUTION_APACHE_LICENSE_LINK);

      const resolvedLicensePath = path.join(path.dirname(packagedNoticePath), packagedLicenseLink);
      const expectedLicensePath = path.join(serverDir, "dist/LICENSES/Apache-2.0.txt");
      assert.equal(resolvedLicensePath, expectedLicensePath);
      assert.isTrue(yield* fs.exists(resolvedLicensePath));

      const sourceLicense = yield* fs.readFileString(
        path.join(repoRoot, "LICENSES/Apache-2.0.txt"),
      );
      const packagedLicense = yield* fs.readFileString(resolvedLicensePath);
      assert.equal(packagedLicense, sourceLicense);
      assert.include(packagedNotice, "Canopy / Git Tree Visualizer");
      assert.include(packagedNotice, "Copyright 2026 Block, Inc.");
      assert.include(packagedLicense, "Apache License");
      assert.include(packagedLicense, "Copyright 2026 Block, Inc.");
    }),
  );
});
