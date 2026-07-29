/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Block, Inc.
 * Adapted from Canopy Git Visualizer (commit 8bc295dc1a210fbb648f4cf42203ae5d2c4c9478).
 */

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import {
  GitCommandError,
  type GitTreeBranch,
  type GitTreeBranchStatus,
  type GitTreeDirectCommit,
  type GitTreeMerge,
  type GitTreeSnapshotResult,
} from "@t3tools/contracts";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export const GIT_TREE_BRANCH_LIMIT = 100;
export const GIT_TREE_MERGE_LIMIT = 100;
export const GIT_TREE_DIRECT_COMMIT_LIMIT = 300;

const GIT_TREE_COMMAND_TIMEOUT_MS = 5_000;
const GIT_TREE_SNAPSHOT_TIMEOUT = "20 seconds";
const GIT_TREE_METADATA_MAX_OUTPUT_BYTES = 512 * 1024;
const GIT_TREE_LOG_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const GIT_TREE_BRANCH_FORMAT =
  "--format=%(refname:short)%00%(HEAD)%00%(objectname)%00%(authorname)%00%(authordate:iso-strict)%00";

interface ParsedBranch {
  readonly name: string;
  readonly current: boolean;
  readonly headSha: string;
  readonly lastCommitAuthor: string;
  readonly lastCommitDate: string;
}

interface BranchRelation {
  readonly ahead: number;
  readonly behind: number;
  readonly divergedFromSha: string | null;
}

interface ParsedRecords<A> {
  readonly records: ReadonlyArray<A>;
  readonly incomplete: boolean;
}

function stripFinalLineEnding(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function repositoryName(root: string): string {
  const withoutTrailingSeparators = root.replace(/[\\/]+$/g, "");
  const separatorIndex = Math.max(
    withoutTrailingSeparators.lastIndexOf("/"),
    withoutTrailingSeparators.lastIndexOf("\\"),
  );
  return withoutTrailingSeparators.slice(separatorIndex + 1) || root;
}

function parseNonNegativeInt(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseFlatNullRecords<A>(
  stdout: string,
  fieldCount: number,
  parse: (fields: ReadonlyArray<string>) => A | null,
): ParsedRecords<A> {
  const fields = stdout.split("\0");
  const terminated = fields.at(-1) === "";
  if (terminated) fields.pop();

  const completeFieldCount = Math.floor(fields.length / fieldCount) * fieldCount;
  const records: A[] = [];
  for (let index = 0; index < completeFieldCount; index += fieldCount) {
    const record = parse(fields.slice(index, index + fieldCount));
    if (record !== null) records.push(record);
  }

  return {
    records,
    incomplete: !terminated || completeFieldCount !== fields.length,
  };
}

export function parseGitTreeBranches(
  stdout: string,
  stdoutTruncated = false,
): ParsedRecords<ParsedBranch> {
  const chunks = stdout.split("\0\n");
  const terminated = chunks.at(-1) === "";
  if (terminated) chunks.pop();
  if (stdoutTruncated && !terminated) chunks.pop();

  const records: ParsedBranch[] = [];
  let malformed = false;
  for (const chunk of chunks) {
    const fields = chunk.split("\0");
    if (fields.length !== 5) {
      malformed = true;
      continue;
    }
    const [name = "", headMarker = "", headSha = "", author = "", date = ""] = fields;
    if (name.length === 0 || headSha.length === 0 || date.length === 0) {
      malformed = true;
      continue;
    }
    records.push({
      name,
      current: headMarker === "*",
      headSha,
      lastCommitAuthor: author,
      lastCommitDate: date,
    });
  }

  return {
    records,
    incomplete: stdoutTruncated || !terminated || malformed,
  };
}

export function parseGitTreeDirectCommits(
  stdout: string,
  stdoutTruncated = false,
): ParsedRecords<GitTreeDirectCommit> {
  const parsed = parseFlatNullRecords(stdout, 5, (fields) => {
    const [fullSha = "", sha = "", message = "", author = "", date = ""] = fields;
    if (fullSha.length === 0 || sha.length === 0 || date.length === 0) return null;
    return { fullSha, sha, message, author, date };
  });
  return {
    records: parsed.records,
    incomplete: stdoutTruncated || parsed.incomplete,
  };
}

export function parseGitTreePullRequestSubject(subject: string): {
  readonly prNumber: number | null;
  readonly prTitle: string | null;
} {
  const pullRequestMerge = /^Merge pull request #(\d+)(?:\s+from\s+(.+))?$/.exec(subject);
  if (pullRequestMerge) {
    const prNumber = parseNonNegativeInt(pullRequestMerge[1]);
    return {
      prNumber: prNumber > 0 ? prNumber : null,
      prTitle: pullRequestMerge[2]?.trim() || null,
    };
  }

  const parenthesized = /\(#(\d+)\)/.exec(subject);
  if (parenthesized) {
    const prNumber = parseNonNegativeInt(parenthesized[1]);
    const title = subject.slice(0, parenthesized.index).trim();
    return {
      prNumber: prNumber > 0 ? prNumber : null,
      prTitle: title.length > 0 ? title : null,
    };
  }

  const bare = /#(\d+)/.exec(subject);
  if (bare) {
    const prNumber = parseNonNegativeInt(bare[1]);
    return { prNumber: prNumber > 0 ? prNumber : null, prTitle: null };
  }

  return { prNumber: null, prTitle: null };
}

export function parseGitTreeMerges(
  stdout: string,
  stdoutTruncated = false,
): ParsedRecords<GitTreeMerge> {
  const parsed = parseFlatNullRecords(stdout, 4, (fields) => {
    const [fullSha = "", sha = "", subject = "", date = ""] = fields;
    if (fullSha.length === 0 || sha.length === 0 || date.length === 0) return null;
    return {
      fullSha,
      sha,
      subject,
      date,
      ...parseGitTreePullRequestSubject(subject),
    };
  });
  return {
    records: parsed.records,
    incomplete: stdoutTruncated || parsed.incomplete,
  };
}

export function gitTreeBranchStatus(
  behind: number,
  lastCommitDate: string,
  nowMs: number,
): GitTreeBranchStatus {
  if (behind > 50) return "stale";
  if (behind > 10) return "conflict-risk";

  const commitTime = Date.parse(lastCommitDate);
  if (!Number.isFinite(commitTime)) return "unknown";
  if (nowMs - commitTime > 14 * 24 * 60 * 60 * 1_000) return "stale";
  return "fresh";
}

function parseAheadBehind(stdout: string): Pick<BranchRelation, "ahead" | "behind"> | null {
  const [behindRaw, aheadRaw] = stdout.trim().split(/\s+/, 2);
  if (!behindRaw || !aheadRaw || !/^\d+$/.test(behindRaw) || !/^\d+$/.test(aheadRaw)) {
    return null;
  }
  const ahead = Number(aheadRaw);
  const behind = Number(behindRaw);
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) return null;
  return {
    ahead,
    behind,
  };
}

function unexpectedGitExit(input: {
  readonly operation: string;
  readonly command: string;
  readonly cwd: string;
  readonly result: GitVcsDriver.ExecuteGitResult;
  readonly fallbackDetail: string;
}): GitCommandError {
  return new GitCommandError({
    operation: input.operation,
    command: input.command,
    cwd: input.cwd,
    exitCode: Number(input.result.exitCode),
    stdoutLength: input.result.stdout.length,
    stderrLength: input.result.stderr.length,
    detail: input.result.stderr.trim() || input.fallbackDetail,
  });
}

function malformedGitOutput(input: {
  readonly operation: string;
  readonly command: string;
  readonly cwd: string;
  readonly detail: string;
}): GitCommandError {
  return new GitCommandError({
    operation: input.operation,
    command: input.command,
    cwd: input.cwd,
    detail: input.detail,
  });
}

function isNotGitRepositoryError(result: GitVcsDriver.ExecuteGitResult): boolean {
  return result.stderr.toLowerCase().includes("not a git repository");
}

function parseCommitDates(stdout: string): ParsedRecords<readonly [string, string]> {
  return parseFlatNullRecords(stdout, 2, (fields) => {
    const [sha = "", date = ""] = fields;
    return sha.length > 0 && date.length > 0 ? ([sha, date] as const) : null;
  });
}

function resolveDefaultBranch(input: {
  readonly remoteDefaultRef: string | null;
  readonly localBranches: ReadonlyArray<ParsedBranch>;
  readonly currentBranch: string | null;
}): string | null {
  const localNames = new Set(input.localBranches.map((branch) => branch.name));
  const remoteDefault = input.remoteDefaultRef?.replace(/^[^/]+\//, "") ?? null;
  if (remoteDefault && localNames.has(remoteDefault)) return remoteDefault;
  if (localNames.has("main")) return "main";
  if (localNames.has("master")) return "master";
  if (input.currentBranch && (localNames.has(input.currentBranch) || localNames.size === 0)) {
    return input.currentBranch;
  }
  return null;
}

function remoteDefaultBranchName(remoteDefaultRef: string | null): string | null {
  return remoteDefaultRef?.replace(/^[^/]+\//, "") ?? null;
}

function uniqueBranchNames(names: ReadonlyArray<string | null>): string[] {
  return Array.from(new Set(names.filter((name): name is string => name !== null)));
}

function selectBoundedBranches(input: {
  readonly recentBranches: ReadonlyArray<ParsedBranch>;
  readonly essentialBranches: ReadonlyArray<ParsedBranch>;
  readonly currentBranch: string | null;
  readonly defaultBranch: string | null;
}): ParsedBranch[] {
  const byName = new Map(
    [...input.recentBranches, ...input.essentialBranches].map((branch) => [branch.name, branch]),
  );
  const requiredNames = uniqueBranchNames([input.defaultBranch, input.currentBranch]);
  const requiredNameSet = new Set(requiredNames);
  const selected = input.recentBranches.slice(0, GIT_TREE_BRANCH_LIMIT);

  for (const requiredName of requiredNames) {
    if (selected.some((branch) => branch.name === requiredName)) continue;
    const requiredBranch = byName.get(requiredName);
    if (!requiredBranch) continue;

    if (selected.length < GIT_TREE_BRANCH_LIMIT) {
      selected.push(requiredBranch);
      continue;
    }

    for (let index = selected.length - 1; index >= 0; index -= 1) {
      if (requiredNameSet.has(selected[index]?.name ?? "")) continue;
      selected[index] = requiredBranch;
      break;
    }
  }

  return selected;
}

export const readGitTreeSnapshot = Effect.fn("GitTreeSnapshot.read")(function* (
  git: GitVcsDriver.GitVcsDriver["Service"],
  requestedCwd: string,
): Effect.fn.Return<GitTreeSnapshotResult, GitCommandError> {
  const execute = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly maxOutputBytes?: number;
      readonly allowNonZeroExit?: boolean;
    },
  ) =>
    git.execute({
      operation,
      cwd,
      args,
      timeoutMs: GIT_TREE_COMMAND_TIMEOUT_MS,
      maxOutputBytes: options?.maxOutputBytes ?? GIT_TREE_METADATA_MAX_OUTPUT_BYTES,
      ...(options?.allowNonZeroExit !== undefined
        ? { allowNonZeroExit: options.allowNonZeroExit }
        : {}),
    });

  const program = Effect.gen(function* () {
    const rootResult = yield* execute(
      "GitTreeSnapshot.resolveRoot",
      requestedCwd,
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      { allowNonZeroExit: true },
    );
    if (rootResult.exitCode !== 0) {
      if (isNotGitRepositoryError(rootResult)) {
        return {
          _tag: "notGitRepository" as const,
          requestedCwd,
        };
      }
      return yield* unexpectedGitExit({
        operation: "GitTreeSnapshot.resolveRoot",
        command: "git rev-parse --show-toplevel",
        cwd: requestedCwd,
        result: rootResult,
        fallbackDetail: "Failed to resolve the Git worktree root.",
      });
    }

    const root = stripFinalLineEnding(rootResult.stdout);
    if (root.length === 0) {
      return yield* malformedGitOutput({
        operation: "GitTreeSnapshot.resolveRoot",
        command: "git rev-parse --show-toplevel",
        cwd: requestedCwd,
        detail: "Git returned an empty worktree root.",
      });
    }

    const [headResult, currentBranchResult, remoteDefaultResult, branchResult] = yield* Effect.all(
      [
        execute("GitTreeSnapshot.resolveHead", root, ["rev-parse", "--verify", "HEAD^{commit}"], {
          allowNonZeroExit: true,
        }),
        execute(
          "GitTreeSnapshot.currentBranch",
          root,
          ["symbolic-ref", "--quiet", "--short", "HEAD"],
          { allowNonZeroExit: true },
        ),
        execute(
          "GitTreeSnapshot.defaultBranch",
          root,
          ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
          { allowNonZeroExit: true },
        ),
        execute("GitTreeSnapshot.branches", root, [
          "for-each-ref",
          `--count=${GIT_TREE_BRANCH_LIMIT + 1}`,
          "--sort=-authordate",
          GIT_TREE_BRANCH_FORMAT,
          "refs/heads",
        ]),
      ],
      { concurrency: 4 },
    );

    if (currentBranchResult.exitCode !== 0 && Number(currentBranchResult.exitCode) !== 1) {
      return yield* unexpectedGitExit({
        operation: "GitTreeSnapshot.currentBranch",
        command: "git symbolic-ref --short HEAD",
        cwd: root,
        result: currentBranchResult,
        fallbackDetail: "Failed to resolve the current branch.",
      });
    }
    if (remoteDefaultResult.exitCode !== 0 && Number(remoteDefaultResult.exitCode) !== 1) {
      return yield* unexpectedGitExit({
        operation: "GitTreeSnapshot.defaultBranch",
        command: "git symbolic-ref refs/remotes/origin/HEAD",
        cwd: root,
        result: remoteDefaultResult,
        fallbackDetail: "Failed to resolve origin/HEAD.",
      });
    }
    const currentBranch =
      currentBranchResult.exitCode === 0
        ? stripFinalLineEnding(currentBranchResult.stdout) || null
        : null;
    const remoteDefaultRef =
      remoteDefaultResult.exitCode === 0
        ? stripFinalLineEnding(remoteDefaultResult.stdout) || null
        : null;
    let isEmpty = false;
    if (headResult.exitCode !== 0) {
      if (!currentBranch) {
        return yield* unexpectedGitExit({
          operation: "GitTreeSnapshot.resolveHead",
          command: "git rev-parse --verify HEAD^{commit}",
          cwd: root,
          result: headResult,
          fallbackDetail: "HEAD is invalid and is not an unborn symbolic branch.",
        });
      }

      const unbornHeadResult = yield* execute(
        "GitTreeSnapshot.verifyUnbornHead",
        root,
        ["show-ref", "--verify", "--quiet", `refs/heads/${currentBranch}`],
        { allowNonZeroExit: true },
      );
      if (Number(unbornHeadResult.exitCode) === 1) {
        isEmpty = true;
      } else if (unbornHeadResult.exitCode === 0) {
        return yield* unexpectedGitExit({
          operation: "GitTreeSnapshot.resolveHead",
          command: "git rev-parse --verify HEAD^{commit}",
          cwd: root,
          result: headResult,
          fallbackDetail: "HEAD points at an existing ref that is not a readable commit.",
        });
      } else {
        return yield* unexpectedGitExit({
          operation: "GitTreeSnapshot.verifyUnbornHead",
          command: "git show-ref --verify HEAD",
          cwd: root,
          result: unbornHeadResult,
          fallbackDetail: "Failed to verify whether HEAD is unborn.",
        });
      }
    }
    const parsedBranches = parseGitTreeBranches(branchResult.stdout, branchResult.stdoutTruncated);
    if (parsedBranches.incomplete && !branchResult.stdoutTruncated) {
      return yield* malformedGitOutput({
        operation: "GitTreeSnapshot.branches",
        command: "git for-each-ref refs/heads",
        cwd: root,
        detail: "Git returned malformed branch metadata.",
      });
    }
    const branchesTruncated =
      parsedBranches.incomplete || parsedBranches.records.length > GIT_TREE_BRANCH_LIMIT;
    const recentBranchNames = new Set(parsedBranches.records.map((branch) => branch.name));
    const essentialBranchNames = uniqueBranchNames([
      remoteDefaultBranchName(remoteDefaultRef),
      currentBranch,
      "main",
      "master",
    ]).filter((name) => !recentBranchNames.has(name));
    const essentialBranches = isEmpty
      ? []
      : yield* Effect.forEach(
          essentialBranchNames,
          Effect.fn("GitTreeSnapshot.readEssentialBranch")(function* (name) {
            const exists = yield* execute(
              "GitTreeSnapshot.verifyEssentialBranch",
              root,
              ["show-ref", "--verify", "--quiet", `refs/heads/${name}`],
              { allowNonZeroExit: true },
            );
            if (Number(exists.exitCode) === 1) return null;
            if (exists.exitCode !== 0) {
              return yield* unexpectedGitExit({
                operation: "GitTreeSnapshot.verifyEssentialBranch",
                command: "git show-ref --verify",
                cwd: root,
                result: exists,
                fallbackDetail: `Failed to verify essential branch ${name}.`,
              });
            }

            const result = yield* execute("GitTreeSnapshot.essentialBranch", root, [
              "show",
              "--no-patch",
              "-z",
              "--format=%H%x00%an%x00%aI",
              `refs/heads/${name}`,
            ]);
            const parsed = parseFlatNullRecords(result.stdout, 3, (fields) => {
              const [headSha = "", author = "", date = ""] = fields;
              return headSha.length > 0 && date.length > 0
                ? ({
                    name,
                    current: name === currentBranch,
                    headSha,
                    lastCommitAuthor: author,
                    lastCommitDate: date,
                  } satisfies ParsedBranch)
                : null;
            });
            if (result.stdoutTruncated || parsed.incomplete || parsed.records.length !== 1) {
              return yield* malformedGitOutput({
                operation: "GitTreeSnapshot.essentialBranch",
                command: "git show --no-patch",
                cwd: root,
                detail: `Git returned malformed metadata for essential branch ${name}.`,
              });
            }
            return parsed.records[0] ?? null;
          }),
          { concurrency: 4 },
        ).pipe(Effect.map((branches) => branches.filter((branch) => branch !== null)));
    const allKnownBranches = [...parsedBranches.records, ...essentialBranches];
    const defaultBranch = resolveDefaultBranch({
      remoteDefaultRef,
      localBranches: allKnownBranches,
      currentBranch,
    });
    const localBranches = selectBoundedBranches({
      recentBranches: parsedBranches.records,
      essentialBranches,
      currentBranch,
      defaultBranch,
    });

    if (isEmpty) {
      return {
        _tag: "repository" as const,
        requestedCwd,
        root,
        name: repositoryName(root),
        currentBranch,
        defaultBranch,
        isEmpty: true,
        branches: [],
        merges: [],
        directCommits: [],
        truncated: {
          branches: branchesTruncated,
          merges: false,
          directCommits: false,
        },
      };
    }

    const branchRelations = yield* Effect.forEach(
      localBranches,
      (branch): Effect.Effect<BranchRelation, GitCommandError> => {
        if (!defaultBranch || branch.name === defaultBranch) {
          return Effect.succeed({ ahead: 0, behind: 0, divergedFromSha: null });
        }

        const defaultRef = `refs/heads/${defaultBranch}`;
        const branchRef = `refs/heads/${branch.name}`;
        return Effect.gen(function* () {
          const counts = yield* execute("GitTreeSnapshot.branchAheadBehind", root, [
            "rev-list",
            "--left-right",
            "--count",
            `${defaultRef}...${branchRef}`,
          ]);
          const mergeBase = yield* execute(
            "GitTreeSnapshot.branchMergeBase",
            root,
            ["merge-base", defaultRef, branchRef],
            { allowNonZeroExit: true },
          );
          const parsedCounts = parseAheadBehind(counts.stdout);
          if (!parsedCounts) {
            return yield* malformedGitOutput({
              operation: "GitTreeSnapshot.branchAheadBehind",
              command: "git rev-list --left-right --count",
              cwd: root,
              detail: `Git returned malformed ahead/behind counts for branch ${branch.name}.`,
            });
          }
          let divergedFromSha: string | null = null;
          if (mergeBase.exitCode === 0) {
            divergedFromSha = stripFinalLineEnding(mergeBase.stdout) || null;
            if (!divergedFromSha) {
              return yield* malformedGitOutput({
                operation: "GitTreeSnapshot.branchMergeBase",
                command: "git merge-base",
                cwd: root,
                detail: `Git returned an empty merge base for branch ${branch.name}.`,
              });
            }
          } else if (Number(mergeBase.exitCode) !== 1 || mergeBase.stderr.trim().length > 0) {
            return yield* unexpectedGitExit({
              operation: "GitTreeSnapshot.branchMergeBase",
              command: "git merge-base",
              cwd: root,
              result: mergeBase,
              fallbackDetail: `Failed to resolve the merge base for branch ${branch.name}.`,
            });
          }
          return {
            ...parsedCounts,
            divergedFromSha,
          };
        });
      },
      { concurrency: 4 },
    );

    const divergenceShas = Array.from(
      new Set(
        branchRelations.flatMap((relation) =>
          relation.divergedFromSha ? [relation.divergedFromSha] : [],
        ),
      ),
    );
    const divergenceDateResult =
      divergenceShas.length > 0
        ? yield* execute("GitTreeSnapshot.divergenceDates", root, [
            "show",
            "--no-patch",
            "-z",
            "--format=%H%x00%aI",
            ...divergenceShas,
          ])
        : null;
    const parsedDivergenceDates = divergenceDateResult
      ? parseCommitDates(divergenceDateResult.stdout)
      : { records: [], incomplete: false };
    if (divergenceDateResult?.stdoutTruncated || parsedDivergenceDates.incomplete) {
      return yield* malformedGitOutput({
        operation: "GitTreeSnapshot.divergenceDates",
        command: "git show --no-patch",
        cwd: root,
        detail: "Git returned incomplete divergence-date metadata.",
      });
    }
    const divergenceDates = new Map(parsedDivergenceDates.records);
    const nowMs = yield* Clock.currentTimeMillis;
    const branches: GitTreeBranch[] = localBranches.map((branch, index) => {
      const relation = branchRelations[index] ?? {
        ahead: 0,
        behind: 0,
        divergedFromSha: null,
      };
      return {
        ...branch,
        ahead: relation.ahead,
        behind: relation.behind,
        divergedFromSha: relation.divergedFromSha,
        divergedFromDate: relation.divergedFromSha
          ? (divergenceDates.get(relation.divergedFromSha) ?? null)
          : null,
        status: gitTreeBranchStatus(relation.behind, branch.lastCommitDate, nowMs),
      };
    });

    const historyRef = defaultBranch ? `refs/heads/${defaultBranch}` : "HEAD";
    const [mergeResult, directCommitResult] = yield* Effect.all(
      [
        execute(
          "GitTreeSnapshot.merges",
          root,
          [
            "log",
            "-z",
            "--merges",
            `--max-count=${GIT_TREE_MERGE_LIMIT + 1}`,
            "--format=%H%x00%h%x00%s%x00%aI",
            historyRef,
          ],
          { maxOutputBytes: GIT_TREE_LOG_MAX_OUTPUT_BYTES },
        ),
        execute(
          "GitTreeSnapshot.directCommits",
          root,
          [
            "log",
            "-z",
            "--no-merges",
            `--max-count=${GIT_TREE_DIRECT_COMMIT_LIMIT + 1}`,
            "--format=%H%x00%h%x00%s%x00%an%x00%aI",
            historyRef,
          ],
          { maxOutputBytes: GIT_TREE_LOG_MAX_OUTPUT_BYTES },
        ),
      ],
      { concurrency: 2 },
    );
    const parsedMerges =
      mergeResult.exitCode === 0
        ? parseGitTreeMerges(mergeResult.stdout, mergeResult.stdoutTruncated)
        : { records: [], incomplete: false };
    const parsedDirectCommits =
      directCommitResult.exitCode === 0
        ? parseGitTreeDirectCommits(directCommitResult.stdout, directCommitResult.stdoutTruncated)
        : { records: [], incomplete: false };
    if (parsedMerges.incomplete && !mergeResult.stdoutTruncated) {
      return yield* malformedGitOutput({
        operation: "GitTreeSnapshot.merges",
        command: "git log --merges",
        cwd: root,
        detail: "Git returned malformed merge history.",
      });
    }
    if (parsedDirectCommits.incomplete && !directCommitResult.stdoutTruncated) {
      return yield* malformedGitOutput({
        operation: "GitTreeSnapshot.directCommits",
        command: "git log --no-merges",
        cwd: root,
        detail: "Git returned malformed direct-commit history.",
      });
    }

    return {
      _tag: "repository" as const,
      requestedCwd,
      root,
      name: repositoryName(root),
      currentBranch,
      defaultBranch,
      isEmpty: false,
      branches,
      merges: parsedMerges.records.slice(0, GIT_TREE_MERGE_LIMIT),
      directCommits: parsedDirectCommits.records.slice(0, GIT_TREE_DIRECT_COMMIT_LIMIT),
      truncated: {
        branches: branchesTruncated,
        merges: parsedMerges.incomplete || parsedMerges.records.length > GIT_TREE_MERGE_LIMIT,
        directCommits:
          parsedDirectCommits.incomplete ||
          parsedDirectCommits.records.length > GIT_TREE_DIRECT_COMMIT_LIMIT,
      },
    };
  });

  return yield* program.pipe(
    Effect.timeoutOrElse({
      duration: GIT_TREE_SNAPSHOT_TIMEOUT,
      orElse: () =>
        new GitCommandError({
          operation: "GitTreeSnapshot.read",
          command: "git tree snapshot",
          cwd: requestedCwd,
          detail: `Timed out after ${GIT_TREE_SNAPSHOT_TIMEOUT}.`,
        }),
    }),
  );
});
