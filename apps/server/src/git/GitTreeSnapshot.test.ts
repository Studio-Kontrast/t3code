import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import { GitCommandError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitTreeSnapshot from "./GitTreeSnapshot.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const RealGitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest("/tmp", { prefix: "t3-git-tree-test-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

function gitOutput(
  stdout: string,
  options?: {
    readonly exitCode?: number;
    readonly stderr?: string;
    readonly stdoutTruncated?: boolean;
  },
): GitVcsDriver.ExecuteGitResult {
  return {
    exitCode: ChildProcessSpawner.ExitCode(options?.exitCode ?? 0),
    stdout,
    stderr: options?.stderr ?? "",
    stdoutTruncated: options?.stdoutTruncated ?? false,
    stderrTruncated: false,
  };
}

function branchRecord(fields: readonly [string, string, string, string, string]): string {
  return `${fields.join("\0")}\0\n`;
}

function logRecord(fields: ReadonlyArray<string>): string {
  return `${fields.join("\0")}\0`;
}

describe("Git tree parsers", () => {
  it("parses NUL-delimited branch metadata without splitting newlines or pipes in authors", () => {
    const parsed = GitTreeSnapshot.parseGitTreeBranches(
      branchRecord([
        "feature/tree",
        "*",
        "abcdef0123456789",
        "Ada | Lovelace\nTeam",
        "2026-07-13T12:00:00+02:00",
      ]),
    );

    assert.deepStrictEqual(parsed, {
      records: [
        {
          name: "feature/tree",
          current: true,
          headSha: "abcdef0123456789",
          lastCommitAuthor: "Ada | Lovelace\nTeam",
          lastCommitDate: "2026-07-13T12:00:00+02:00",
        },
      ],
      incomplete: false,
    });
  });

  it("drops an incomplete final log record when process output is truncated", () => {
    const complete = logRecord([
      "abcdef0123456789",
      "abcdef0",
      "complete | subject",
      "Ada\nTeam",
      "2026-07-13T12:00:00+02:00",
    ]);
    const parsed = GitTreeSnapshot.parseGitTreeDirectCommits(`${complete}partial\0record`, true);

    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.records[0]?.message, "complete | subject");
    assert.equal(parsed.records[0]?.author, "Ada\nTeam");
    assert.isTrue(parsed.incomplete);
  });

  it("extracts common pull request numbers and titles from merge subjects", () => {
    assert.deepStrictEqual(
      GitTreeSnapshot.parseGitTreePullRequestSubject(
        "Merge pull request #42 from octocat/feature/tree",
      ),
      { prNumber: 42, prTitle: "octocat/feature/tree" },
    );
    assert.deepStrictEqual(GitTreeSnapshot.parseGitTreePullRequestSubject("feat: add tree (#57)"), {
      prNumber: 57,
      prTitle: "feat: add tree",
    });
    assert.deepStrictEqual(GitTreeSnapshot.parseGitTreePullRequestSubject("Merge branch 'next'"), {
      prNumber: null,
      prTitle: null,
    });
  });

  it("classifies branch freshness with the Canopy-compatible thresholds", () => {
    const now = Date.parse("2026-07-20T00:00:00Z");
    assert.equal(GitTreeSnapshot.gitTreeBranchStatus(0, "2026-07-19T00:00:00Z", now), "fresh");
    assert.equal(
      GitTreeSnapshot.gitTreeBranchStatus(11, "2026-07-19T00:00:00Z", now),
      "conflict-risk",
    );
    assert.equal(GitTreeSnapshot.gitTreeBranchStatus(51, "2026-07-19T00:00:00Z", now), "stale");
    assert.equal(GitTreeSnapshot.gitTreeBranchStatus(0, "invalid", now), "unknown");
  });
});

describe("readGitTreeSnapshot", () => {
  it.effect("returns a typed non-repository result after only the fixed root probe", () => {
    const execute = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["execute"]>(() =>
      Effect.succeed(
        gitOutput("", {
          exitCode: 128,
          stderr: "fatal: not a git repository (or any of the parent directories): .git",
        }),
      ),
    );

    return Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      const snapshot = yield* GitTreeSnapshot.readGitTreeSnapshot(git, "/tmp/not-git");

      assert.deepStrictEqual(snapshot, {
        _tag: "notGitRepository",
        requestedCwd: "/tmp/not-git",
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith({
        operation: "GitTreeSnapshot.resolveRoot",
        cwd: "/tmp/not-git",
        args: ["rev-parse", "--path-format=absolute", "--show-toplevel"],
        timeoutMs: 5_000,
        maxOutputBytes: 512 * 1024,
        allowNonZeroExit: true,
      });
    }).pipe(
      Effect.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          execute,
        }),
      ),
    );
  });

  it.effect(
    "propagates an unexpected root-probe failure instead of reporting a non-repository",
    () => {
      const execute = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["execute"]>(() =>
        Effect.succeed(
          gitOutput("", {
            exitCode: 128,
            stderr: "fatal: cannot change to '/missing': No such file or directory",
          }),
        ),
      );

      return Effect.gen(function* () {
        const git = yield* GitVcsDriver.GitVcsDriver;
        const error = yield* GitTreeSnapshot.readGitTreeSnapshot(git, "/missing").pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "GitCommandError",
          operation: "GitTreeSnapshot.resolveRoot",
          cwd: "/missing",
        });
      }).pipe(Effect.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({ execute })));
    },
  );

  it.effect("handles an unborn repository without running history commands", () => {
    const execute = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["execute"]>((input) => {
      switch (input.operation) {
        case "GitTreeSnapshot.resolveRoot":
          return Effect.succeed(gitOutput("/tmp/empty-repo\n"));
        case "GitTreeSnapshot.resolveHead":
          return Effect.succeed(gitOutput("", { exitCode: 128 }));
        case "GitTreeSnapshot.currentBranch":
          return Effect.succeed(gitOutput("main\n"));
        case "GitTreeSnapshot.defaultBranch":
          return Effect.succeed(gitOutput("", { exitCode: 1 }));
        case "GitTreeSnapshot.branches":
          return Effect.succeed(gitOutput(""));
        case "GitTreeSnapshot.verifyUnbornHead":
          return Effect.succeed(gitOutput("", { exitCode: 1 }));
        default:
          return Effect.die(new Error(`Unexpected operation: ${input.operation}`));
      }
    });

    return Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      const snapshot = yield* GitTreeSnapshot.readGitTreeSnapshot(git, "/tmp/empty-repo/nested");

      assert.deepStrictEqual(snapshot, {
        _tag: "repository",
        requestedCwd: "/tmp/empty-repo/nested",
        root: "/tmp/empty-repo",
        name: "empty-repo",
        currentBranch: "main",
        defaultBranch: "main",
        isEmpty: true,
        branches: [],
        merges: [],
        directCommits: [],
        truncated: { branches: false, merges: false, directCommits: false },
      });
      expect(execute).toHaveBeenCalledTimes(6);
    }).pipe(Effect.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({ execute })));
  });

  it.effect("rejects a broken existing HEAD instead of treating it as an unborn repository", () => {
    const execute = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["execute"]>((input) => {
      switch (input.operation) {
        case "GitTreeSnapshot.resolveRoot":
          return Effect.succeed(gitOutput("/tmp/broken-head\n"));
        case "GitTreeSnapshot.resolveHead":
          return Effect.succeed(gitOutput("", { exitCode: 128, stderr: "fatal: bad object HEAD" }));
        case "GitTreeSnapshot.currentBranch":
          return Effect.succeed(gitOutput("main\n"));
        case "GitTreeSnapshot.defaultBranch":
          return Effect.succeed(gitOutput("", { exitCode: 1 }));
        case "GitTreeSnapshot.branches":
          return Effect.succeed(
            gitOutput(
              branchRecord([
                "main",
                "*",
                "ffffffffffffffffffffffffffffffffffffffff",
                "Broken",
                "2026-07-13T12:00:00+02:00",
              ]),
            ),
          );
        case "GitTreeSnapshot.verifyUnbornHead":
          return Effect.succeed(gitOutput("", { exitCode: 0 }));
        default:
          return Effect.die(new Error(`Unexpected operation: ${input.operation}`));
      }
    });

    return Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      const error = yield* GitTreeSnapshot.readGitTreeSnapshot(git, "/tmp/broken-head").pipe(
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitTreeSnapshot.resolveHead",
      });
    }).pipe(Effect.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({ execute })));
  });

  it.effect("propagates branch collection failures", () => {
    const branchError = new GitCommandError({
      operation: "GitTreeSnapshot.branches",
      command: "git for-each-ref",
      cwd: "/tmp/repo",
      detail: "cannot read refs",
    });
    const execute = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["execute"]>((input) => {
      if (input.operation === "GitTreeSnapshot.branches") return Effect.fail(branchError);
      if (input.operation === "GitTreeSnapshot.resolveRoot") {
        return Effect.succeed(gitOutput("/tmp/repo\n"));
      }
      if (input.operation === "GitTreeSnapshot.resolveHead") {
        return Effect.succeed(gitOutput("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"));
      }
      if (input.operation === "GitTreeSnapshot.currentBranch") {
        return Effect.succeed(gitOutput("main\n"));
      }
      if (input.operation === "GitTreeSnapshot.defaultBranch") {
        return Effect.succeed(gitOutput("", { exitCode: 1 }));
      }
      return Effect.die(new Error(`Unexpected operation: ${input.operation}`));
    });

    return Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      const error = yield* GitTreeSnapshot.readGitTreeSnapshot(git, "/tmp/repo").pipe(Effect.flip);

      assert.strictEqual(error, branchError);
      const branchInput = execute.mock.calls.find(
        ([input]) => input.operation === "GitTreeSnapshot.branches",
      )?.[0];
      assert.isUndefined(branchInput?.allowNonZeroExit);
    }).pipe(Effect.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({ execute })));
  });

  it.effect("propagates history collection failures", () => {
    const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const logError = new GitCommandError({
      operation: "GitTreeSnapshot.merges",
      command: "git log --merges",
      cwd: "/tmp/repo",
      detail: "cannot walk history",
    });
    const execute = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["execute"]>((input) => {
      switch (input.operation) {
        case "GitTreeSnapshot.resolveRoot":
          return Effect.succeed(gitOutput("/tmp/repo\n"));
        case "GitTreeSnapshot.resolveHead":
          return Effect.succeed(gitOutput(`${sha}\n`));
        case "GitTreeSnapshot.currentBranch":
          return Effect.succeed(gitOutput("main\n"));
        case "GitTreeSnapshot.defaultBranch":
          return Effect.succeed(gitOutput("", { exitCode: 1 }));
        case "GitTreeSnapshot.branches":
          return Effect.succeed(
            gitOutput(branchRecord(["main", "*", sha, "Author", "2026-07-13T12:00:00Z"])),
          );
        case "GitTreeSnapshot.verifyEssentialBranch":
          return Effect.succeed(gitOutput("", { exitCode: 1 }));
        case "GitTreeSnapshot.merges":
          return Effect.fail(logError);
        case "GitTreeSnapshot.directCommits":
          return Effect.succeed(gitOutput(""));
        default:
          return Effect.die(new Error(`Unexpected operation: ${input.operation}`));
      }
    });

    return Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      const error = yield* GitTreeSnapshot.readGitTreeSnapshot(git, "/tmp/repo").pipe(Effect.flip);

      assert.strictEqual(error, logError);
      const logInput = execute.mock.calls.find(
        ([input]) => input.operation === "GitTreeSnapshot.merges",
      )?.[0];
      assert.isUndefined(logInput?.allowNonZeroExit);
    }).pipe(Effect.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({ execute })));
  });

  it.effect(
    "builds the bounded snapshot from fixed Git queries rooted at the canonical repo",
    () => {
      const featureSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const mainSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const baseSha = "cccccccccccccccccccccccccccccccccccccccc";
      const branches =
        branchRecord([
          "feature/tree",
          "*",
          featureSha,
          "Ada | Team\nOne",
          "2026-07-13T12:00:00+02:00",
        ]) + branchRecord(["main", " ", mainSha, "Grace", "2026-07-12T12:00:00+02:00"]);
      const merges = logRecord([
        "dddddddddddddddddddddddddddddddddddddddd",
        "ddddddd",
        "feat: tree (#42)",
        "2026-07-12T11:00:00+02:00",
      ]).repeat(GitTreeSnapshot.GIT_TREE_MERGE_LIMIT + 1);
      const directCommits = logRecord([
        mainSha,
        "bbbbbbb",
        "feat: direct | commit",
        "Grace\nTeam",
        "2026-07-12T12:00:00+02:00",
      ]).repeat(GitTreeSnapshot.GIT_TREE_DIRECT_COMMIT_LIMIT + 1);

      const execute = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["execute"]>((input) => {
        switch (input.operation) {
          case "GitTreeSnapshot.resolveRoot":
            return Effect.succeed(gitOutput("/tmp/repo\n"));
          case "GitTreeSnapshot.resolveHead":
            return Effect.succeed(gitOutput(`${featureSha}\n`));
          case "GitTreeSnapshot.currentBranch":
            return Effect.succeed(gitOutput("feature/tree\n"));
          case "GitTreeSnapshot.defaultBranch":
            return Effect.succeed(gitOutput("origin/main\n"));
          case "GitTreeSnapshot.branches":
            return Effect.succeed(gitOutput(branches));
          case "GitTreeSnapshot.verifyEssentialBranch":
            return Effect.succeed(gitOutput("", { exitCode: 1 }));
          case "GitTreeSnapshot.branchAheadBehind":
            return Effect.succeed(gitOutput("1\t2\n"));
          case "GitTreeSnapshot.branchMergeBase":
            return Effect.succeed(gitOutput(`${baseSha}\n`));
          case "GitTreeSnapshot.divergenceDates":
            return Effect.succeed(gitOutput(logRecord([baseSha, "2026-07-10T10:00:00+02:00"])));
          case "GitTreeSnapshot.merges":
            return Effect.succeed(gitOutput(merges));
          case "GitTreeSnapshot.directCommits":
            return Effect.succeed(gitOutput(directCommits));
          default:
            return Effect.die(new Error(`Unexpected operation: ${input.operation}`));
        }
      });

      return Effect.gen(function* () {
        const git = yield* GitVcsDriver.GitVcsDriver;
        const snapshot = yield* GitTreeSnapshot.readGitTreeSnapshot(git, "/tmp/repo/packages/app");

        assert.equal(snapshot._tag, "repository");
        if (snapshot._tag !== "repository") return;
        assert.equal(snapshot.root, "/tmp/repo");
        assert.equal(snapshot.defaultBranch, "main");
        assert.equal(snapshot.branches.length, 2);
        expect(snapshot.branches[0]).toMatchObject({
          name: "feature/tree",
          current: true,
          ahead: 2,
          behind: 1,
          divergedFromSha: baseSha,
          divergedFromDate: "2026-07-10T10:00:00+02:00",
        });
        expect(snapshot.merges[0]).toMatchObject({
          prNumber: 42,
          prTitle: "feat: tree",
        });
        assert.equal(snapshot.merges.length, GitTreeSnapshot.GIT_TREE_MERGE_LIMIT);
        assert.equal(snapshot.directCommits[0]?.message, "feat: direct | commit");
        assert.equal(snapshot.directCommits.length, GitTreeSnapshot.GIT_TREE_DIRECT_COMMIT_LIMIT);
        assert.deepStrictEqual(snapshot.truncated, {
          branches: false,
          merges: true,
          directCommits: true,
        });

        for (const [input] of execute.mock.calls) {
          if (input.operation !== "GitTreeSnapshot.resolveRoot") {
            assert.equal(input.cwd, "/tmp/repo");
          }
          assert.isAtMost(input.timeoutMs ?? Number.POSITIVE_INFINITY, 5_000);
        }
      }).pipe(Effect.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({ execute })));
    },
  );

  it.effect("keeps old current and default branches when more than 100 newer refs exist", () => {
    const sha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const recentBranches = Array.from(
      { length: GitTreeSnapshot.GIT_TREE_BRANCH_LIMIT + 1 },
      (_, index) =>
        branchRecord([
          `recent-${String(index).padStart(3, "0")}`,
          " ",
          sha,
          "Recent Author",
          "2026-07-13T12:00:00+02:00",
        ]),
    ).join("");
    const essentialMetadata = new Map([
      ["refs/heads/old-current", logRecord([sha, "Current Author", "2025-01-01T12:00:00+01:00"])],
      ["refs/heads/old-default", logRecord([sha, "Default Author", "2025-01-02T12:00:00+01:00"])],
    ]);

    const execute = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["execute"]>((input) => {
      switch (input.operation) {
        case "GitTreeSnapshot.resolveRoot":
          return Effect.succeed(gitOutput("/tmp/many-branches\n"));
        case "GitTreeSnapshot.resolveHead":
          return Effect.succeed(gitOutput(`${sha}\n`));
        case "GitTreeSnapshot.currentBranch":
          return Effect.succeed(gitOutput("old-current\n"));
        case "GitTreeSnapshot.defaultBranch":
          return Effect.succeed(gitOutput("origin/old-default\n"));
        case "GitTreeSnapshot.branches":
          return Effect.succeed(gitOutput(recentBranches));
        case "GitTreeSnapshot.verifyEssentialBranch": {
          const ref = input.args.at(-1) ?? "";
          return Effect.succeed(gitOutput("", { exitCode: essentialMetadata.has(ref) ? 0 : 1 }));
        }
        case "GitTreeSnapshot.essentialBranch":
          return Effect.succeed(gitOutput(essentialMetadata.get(input.args.at(-1) ?? "") ?? ""));
        case "GitTreeSnapshot.branchAheadBehind":
          return Effect.succeed(gitOutput("0\t0\n"));
        case "GitTreeSnapshot.branchMergeBase":
          return Effect.succeed(gitOutput("", { exitCode: 1 }));
        case "GitTreeSnapshot.merges":
        case "GitTreeSnapshot.directCommits":
          return Effect.succeed(gitOutput(""));
        default:
          return Effect.die(new Error(`Unexpected operation: ${input.operation}`));
      }
    });

    return Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      const snapshot = yield* GitTreeSnapshot.readGitTreeSnapshot(git, "/tmp/many-branches");

      assert.equal(snapshot._tag, "repository");
      if (snapshot._tag !== "repository") return;
      const names = snapshot.branches.map((branch) => branch.name);
      assert.equal(snapshot.currentBranch, "old-current");
      assert.equal(snapshot.defaultBranch, "old-default");
      assert.equal(snapshot.branches.length, GitTreeSnapshot.GIT_TREE_BRANCH_LIMIT);
      assert.include(names, "old-current");
      assert.include(names, "old-default");
      assert.isTrue(snapshot.truncated.branches);
      assert.isTrue(
        snapshot.branches.find((branch) => branch.name === "old-current")?.current ?? false,
      );

      const mergeQuery = execute.mock.calls.find(
        ([input]) => input.operation === "GitTreeSnapshot.merges",
      )?.[0];
      assert.equal(mergeQuery?.args.at(-1), "refs/heads/old-default");
    }).pipe(Effect.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({ execute })));
  });

  it.effect("collects branches and merges from a real Git repository using a nested cwd", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const repo = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-tree-repo-" });
      const nestedCwd = path.join(repo, "packages", "app");

      const runGit = (args: ReadonlyArray<string>) =>
        git.execute({
          operation: "GitTreeSnapshot.test.git",
          cwd: repo,
          args,
          timeoutMs: 10_000,
        });

      yield* runGit(["init", "--initial-branch=main"]);
      yield* runGit(["config", "user.email", "git-tree@example.com"]);
      yield* runGit(["config", "user.name", "Git Tree Test"]);
      yield* fileSystem.writeFileString(path.join(repo, "base.txt"), "base\n");
      yield* runGit(["add", "base.txt"]);
      yield* runGit(["commit", "-m", "base"]);
      yield* runGit(["switch", "-c", "feature/tree"]);
      yield* fileSystem.writeFileString(path.join(repo, "feature.txt"), "feature\n");
      yield* runGit(["add", "feature.txt"]);
      yield* runGit(["commit", "-m", "feature"]);
      yield* runGit(["switch", "main"]);
      yield* fileSystem.writeFileString(path.join(repo, "main.txt"), "main\n");
      yield* runGit(["add", "main.txt"]);
      yield* runGit(["commit", "-m", "main"]);
      yield* runGit(["merge", "--no-ff", "feature/tree", "-m", "feat: merge tree (#42)"]);
      yield* fileSystem.makeDirectory(nestedCwd, { recursive: true });

      const canonicalRoot = (yield* runGit([
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
      ])).stdout.trim();
      const snapshot = yield* GitTreeSnapshot.readGitTreeSnapshot(git, nestedCwd);

      assert.equal(snapshot._tag, "repository");
      if (snapshot._tag !== "repository") return;
      assert.equal(snapshot.root, canonicalRoot);
      assert.equal(snapshot.currentBranch, "main");
      assert.equal(snapshot.defaultBranch, "main");
      assert.isFalse(snapshot.isEmpty);
      assert.deepStrictEqual(snapshot.branches.map((branch) => branch.name).sort(), [
        "feature/tree",
        "main",
      ]);
      expect(snapshot.branches.find((branch) => branch.name === "feature/tree")).toMatchObject({
        ahead: 0,
        divergedFromSha: expect.any(String),
        divergedFromDate: expect.any(String),
      });
      expect(snapshot.merges[0]).toMatchObject({
        subject: "feat: merge tree (#42)",
        prNumber: 42,
        prTitle: "feat: merge tree",
      });
      assert.isAbove(snapshot.directCommits.length, 0);
      assert.deepStrictEqual(snapshot.truncated, {
        branches: false,
        merges: false,
        directCommits: false,
      });
    }).pipe(Effect.provide(RealGitLayer)),
  );
});
