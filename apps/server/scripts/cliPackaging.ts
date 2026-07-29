import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const CLI_DISTRIBUTION_NOTICE_ASSETS = [
  {
    sourceRelativePath: "apps/web/THIRD_PARTY_NOTICES.md",
    targetRelativePath: "dist/THIRD_PARTY_NOTICES.md",
  },
  {
    sourceRelativePath: "LICENSES/Apache-2.0.txt",
    targetRelativePath: "dist/LICENSES/Apache-2.0.txt",
  },
] as const;

const REPOSITORY_APACHE_LICENSE_LINK = "../../LICENSES/Apache-2.0.txt";
export const DISTRIBUTION_APACHE_LICENSE_LINK = "./LICENSES/Apache-2.0.txt";

export const copyCliDistributionNotices = Effect.fn("copyCliDistributionNotices")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const copiedTargets: string[] = [];

  for (const asset of CLI_DISTRIBUTION_NOTICE_ASSETS) {
    const sourcePath = path.join(repoRoot, asset.sourceRelativePath);
    const targetPath = path.join(serverDir, asset.targetRelativePath);
    yield* fs.makeDirectory(path.dirname(targetPath), { recursive: true });

    if (asset.targetRelativePath === "dist/THIRD_PARTY_NOTICES.md") {
      const notice = yield* fs.readFileString(sourcePath);
      yield* fs.writeFileString(
        targetPath,
        notice.replace(REPOSITORY_APACHE_LICENSE_LINK, DISTRIBUTION_APACHE_LICENSE_LINK),
      );
    } else {
      yield* fs.copyFile(sourcePath, targetPath);
    }
    copiedTargets.push(targetPath);
  }

  return copiedTargets as ReadonlyArray<string>;
});
