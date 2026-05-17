// @ts-nocheck
export {};

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { getReviewSnapshot } = require("./reviewDiffSnapshots");

function createGitIpcHandlers(deps) {
  const realpathSafe = deps.realpathSafe;
  const isWithinAllowedRoots = deps.isWithinAllowedRoots;
  const parseWorkspaceRoots = deps.parseWorkspaceRoots;
  const activeWorkspaceRootPaths = deps.activeWorkspaceRootPaths || (() => []);
  const GIT_DIFF_BASE_ARGS = [
    "-c",
    "diff.mnemonicPrefix=false",
    "-c",
    "diff.noprefix=false",
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--color=never",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ];
  const GIT_OPERATION_TIMEOUT_MS = 30000;
  const GIT_DIFF_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
  const GIT_FILE_PREVIEW_LIMIT_BYTES = 5 * 1024 * 1024;

  /** 从任意项目路径向上寻找 git root，并校验仍在 allowlist 内。 */
  function findGitRoot(candidatePath) {
    const start = realpathSafe(candidatePath);
    if (!start || !isWithinAllowedRoots(start)) return null;
    const cwd = fs.existsSync(start) && fs.statSync(start).isDirectory() ? start : path.dirname(start);
    try {
      const output = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const resolved = realpathSafe(output);
      return resolved && isWithinAllowedRoots(resolved) ? resolved : null;
    } catch {
      return null;
    }
  }

  /** 官方 getWorkspaceRoot 语义：优先当前 active workspace，再退回保存的 workspace root。 */
  function getWorkspaceRoot() {
    const activeRoots = activeWorkspaceRootPaths();
    if (Array.isArray(activeRoots) && typeof activeRoots[0] === "string" && activeRoots[0].trim()) {
      return activeRoots[0].trim();
    }
    const roots = parseWorkspaceRoots();
    if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0].trim()) {
      return roots[0].trim();
    }
    return null;
  }

  /** 从各类 git IPC payload 中解析 cwd/root/projectPath。 */
  function resolveGitTargetPath(payload) {
    const params =
      payload && typeof payload === "object" && payload.params && typeof payload.params === "object"
        ? payload.params
        : payload;
    const direct =
      params && typeof params === "object"
        ? params.cwd || params.root || params.path || params.rootPath || params.projectPath || null
        : null;
    return typeof direct === "string" && direct.trim() ? direct : getWorkspaceRoot();
  }

  function payloadParams(payload) {
    return payload && typeof payload === "object" && payload.params && typeof payload.params === "object"
      ? payload.params
      : payload;
  }

  function pathInside(basePath, candidatePath) {
    const base = realpathSafe(basePath) || path.resolve(basePath);
    const candidate = realpathSafe(candidatePath) || path.resolve(candidatePath);
    const relative = path.relative(base, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  function fileTextToLines(text) {
    const lines = String(text).split(/(?<=\n)/);
    if (lines.length === 1 && lines[0] === "") return [];
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  function readWorkspaceFileLines(cwd, filePath) {
    if (typeof cwd !== "string" || !cwd.trim() || typeof filePath !== "string" || !filePath.trim()) {
      return null;
    }
    const cwdPath = realpathSafe(cwd.trim()) || path.resolve(cwd.trim());
    if (!isWithinAllowedRoots(cwdPath)) return null;
    const candidatePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(cwdPath, filePath);
    const resolvedPath = realpathSafe(candidatePath);
    if (!resolvedPath || !pathInside(cwdPath, resolvedPath) || !isWithinAllowedRoots(resolvedPath)) return null;
    try {
      const stats = fs.statSync(resolvedPath);
      if (!stats.isFile()) return null;
      if (stats.size > GIT_FILE_PREVIEW_LIMIT_BYTES) return { error: { type: "too-large", limitBytes: GIT_FILE_PREVIEW_LIMIT_BYTES } };
      return fileTextToLines(fs.readFileSync(resolvedPath, "utf8"));
    } catch {
      return null;
    }
  }

  function isBlobObjectId(value) {
    return typeof value === "string" && value.trim().length > 0 && !/^0+$/.test(value.trim());
  }

  /** 归一化 git 分支名，去掉状态行、远端前缀和展示附加信息。 */
  function normalizeBranchName(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.replace(/^##\s*/, "").trim();
    if (!trimmed) return null;
    return trimmed
      .split("...")[0]
      .replace(/\s+\[.*\]$/, "")
      .replace(/^heads\//, "")
      .trim() || null;
  }

  /** 获取 git common dir，兼容 worktree。 */
  function gitCommonDir(gitRoot) {
    try {
      const raw = execFileSync("git", ["-C", gitRoot, "rev-parse", "--git-common-dir"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const resolved = path.isAbsolute(raw) ? raw : path.resolve(gitRoot, raw);
      return realpathSafe(resolved) || resolved;
    } catch {
      return path.join(gitRoot, ".git");
    }
  }

  /** stable-metadata IPC 返回 git root/commonDir，供 renderer 缓存项目身份。 */
  function gitStableMetadataForPayload(payload) {
    const target = resolveGitTargetPath(payload);
    if (!target) return null;
    const gitRoot = findGitRoot(target);
    if (!gitRoot) return null;
    return {
      root: gitRoot,
      commonDir: gitCommonDir(gitRoot),
    };
  }

  /** 获取当前分支；detached HEAD 时返回短 hash 展示值。 */
  function currentGitBranchForRoot(gitRoot) {
    try {
      const branch = execFileSync("git", ["-C", gitRoot, "branch", "--show-current"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (branch) return branch;
    } catch {}

    try {
      const branch = execFileSync("git", ["-C", gitRoot, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (branch && branch !== "HEAD") return branch;
    } catch {}

    try {
      const revision = execFileSync("git", ["-C", gitRoot, "rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return revision ? `HEAD (${revision})` : null;
    } catch {
      return null;
    }
  }

  /** 读取仓库默认分支配置；没有配置时按 git 旧默认值 master 兜底。 */
  function gitDefaultBranchForRoot(gitRoot) {
    try {
      const branch = execFileSync("git", ["-C", gitRoot, "config", "--get", "init.defaultBranch"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (normalizeBranchName(branch)) return normalizeBranchName(branch);
    } catch {}
    return "master";
  }

  /** current-branch IPC 的本地实现。 */
  function currentBranchForPayload(payload) {
    const target = resolveGitTargetPath(payload);
    if (!target) return { branch: null };
    const gitRoot = findGitRoot(target);
    if (!gitRoot) return { root: realpathSafe(target) || path.resolve(target), branch: null };
    return {
      root: gitRoot,
      branch: currentGitBranchForRoot(gitRoot),
    };
  }

  /** recent-branches/search-branches IPC 的本地实现。 */
  function recentBranchesForPayload(payload) {
    const target = resolveGitTargetPath(payload);
    const limit =
      payload && typeof payload === "object" && Number.isFinite(Number(payload.limit))
        ? Math.max(1, Math.min(500, Number(payload.limit)))
        : 100;
    if (!target) return { branches: [] };
    const gitRoot = findGitRoot(target);
    if (!gitRoot) return { branches: [] };

    try {
      const raw = execFileSync(
        "git",
        ["-C", gitRoot, "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }
      );
      const current = currentGitBranchForRoot(gitRoot);
      const seen = new Set();
      const branches = [];
      const add = (branch) => {
        const normalized = normalizeBranchName(branch);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        branches.push(normalized);
      };
      add(current);
      raw.split(/\r?\n/).forEach(add);
      if (!gitHasHeadCommit(gitRoot)) {
        for (const branch of [gitDefaultBranchForRoot(gitRoot), "master", "main"]) {
          add(branch);
        }
      }
      return { root: gitRoot, branches: branches.slice(0, limit) };
    } catch {
      return { root: gitRoot, branches: [] };
    }
  }

  /** 解析创建/切换分支所需的 cwd 和 branch。 */
  function gitBranchMutationPayload(payload) {
    const params =
      payload && typeof payload === "object" && payload.params && typeof payload.params === "object"
        ? payload.params
        : payload;
    const cwd = resolveGitTargetPath(params);
    const branch =
      params && typeof params === "object" && typeof params.branch === "string"
        ? params.branch.trim()
        : "";
    return { params, cwd, branch };
  }

  /** 使用 git check-ref-format 校验分支名，避免 shell/路径注入。 */
  function validateBranchName(gitRoot, branch) {
    if (!branch) throw new Error("Missing branch name");
    try {
      execFileSync("git", ["-C", gitRoot, "check-ref-format", "--branch", branch], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new Error(`Invalid branch name: ${branch}`);
    }
  }

  /** 判断本地分支是否存在。 */
  function gitBranchExists(gitRoot, branch) {
    try {
      execFileSync("git", ["-C", gitRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return true;
    } catch {
      return false;
    }
  }

  /** 判断仓库是否已有 HEAD 提交；新仓库创建分支要走 unborn 分支路径。 */
  function gitHasHeadCommit(gitRoot) {
    try {
      execFileSync("git", ["-C", gitRoot, "rev-parse", "--verify", "--quiet", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return true;
    } catch {
      return false;
    }
  }

  /** 新仓库还没有提交时，通过 symbolic-ref 切换 unborn 分支。 */
  function setGitSymbolicHead(gitRoot, branch) {
    execFileSync("git", ["-C", gitRoot, "symbolic-ref", "HEAD", `refs/heads/${branch}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  /** 把 git 操作异常统一成 renderer 可展示的对象。 */
  function gitMutationError(error, fallbackMessage = "Git operation failed") {
    const message = error instanceof Error ? error.message : String(error || fallbackMessage);
    return {
      status: "error",
      error: message || fallbackMessage,
      message: message || fallbackMessage,
      execOutput: message || null,
    };
  }

  /** 创建本地分支；兼容空仓库，不再假设一定存在 master。 */
  function createGitBranchForPayload(payload) {
    const { params, cwd, branch } = gitBranchMutationPayload(payload);
    if (!cwd) return gitMutationError("Missing cwd");
    const gitRoot = findGitRoot(cwd);
    if (!gitRoot) return gitMutationError("Not a git repository");

    try {
      validateBranchName(gitRoot, branch);
      if (!gitHasHeadCommit(gitRoot)) {
        const current = currentGitBranchForRoot(gitRoot);
        if (current === branch) {
          return { status: "success", branch, root: gitRoot, alreadyCurrent: true, unborn: true };
        }
        setGitSymbolicHead(gitRoot, branch);
        return { status: "success", branch, root: gitRoot, unborn: true };
      }

      const exists = gitBranchExists(gitRoot, branch);
      if (exists) {
        if (params && typeof params === "object" && params.failIfExists) {
          return gitMutationError(`Branch already exists: ${branch}`, "Branch already exists");
        }
        return { status: "success", branch, root: gitRoot, alreadyExists: true };
      }

      execFileSync("git", ["-C", gitRoot, "branch", branch], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: "success", branch, root: gitRoot };
    } catch (error) {
      return gitMutationError(error);
    }
  }

  /** 切换分支；遇到工作区阻塞时返回 renderer 能识别的 errorType。 */
  function checkoutGitBranchForPayload(payload) {
    const { cwd, branch } = gitBranchMutationPayload(payload);
    if (!cwd) return gitMutationError("Missing cwd");
    const gitRoot = findGitRoot(cwd);
    if (!gitRoot) return gitMutationError("Not a git repository");

    try {
      validateBranchName(gitRoot, branch);
      if (currentGitBranchForRoot(gitRoot) === branch) {
        return { status: "success", branch, root: gitRoot, alreadyCurrent: true };
      }
      if (!gitHasHeadCommit(gitRoot)) {
        setGitSymbolicHead(gitRoot, branch);
        return { status: "success", branch, root: gitRoot, unborn: true };
      }

      execFileSync("git", ["-C", gitRoot, "checkout", branch], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: "success", branch, root: gitRoot };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = gitMutationError(error);
      if (/would be overwritten|Please commit your changes|would be lost/i.test(message)) {
        result.errorType = "blocked-by-working-tree-changes";
        result.conflictedPaths = [];
      }
      return result;
    }
  }

  /** 计算 base branch，优先 origin/HEAD，其次 main/master，最后当前分支。 */
  function baseBranchForPayload(payload) {
    const target = resolveGitTargetPath(payload);
    if (!target) return { branch: "main", baseBranch: "main", defaultBranch: "main" };
    const gitRoot = findGitRoot(target);
    if (!gitRoot) return { branch: "main", baseBranch: "main", defaultBranch: "main" };

    if (!gitHasHeadCommit(gitRoot)) {
      const branch = gitDefaultBranchForRoot(gitRoot);
      return { root: gitRoot, branch, baseBranch: branch, defaultBranch: branch, unborn: true };
    }

    const candidates = [];
    try {
      const originHead = execFileSync("git", ["-C", gitRoot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (originHead) candidates.push(originHead.replace(/^origin\//, ""));
    } catch {}
    for (const candidate of ["main", "master"]) {
      if (gitBranchExists(gitRoot, candidate)) candidates.push(candidate);
    }
    const branch = candidates.find(Boolean) || currentGitBranchForRoot(gitRoot) || "main";
    return { root: gitRoot, branch, baseBranch: branch, defaultBranch: branch };
  }

  function gitDefaultBranchForPayload(payload) {
    const target = resolveGitTargetPath(payload);
    if (!target) return { branch: "master", defaultBranch: "master" };
    const gitRoot = findGitRoot(target);
    if (!gitRoot) return { root: realpathSafe(target) || path.resolve(target), branch: "master", defaultBranch: "master" };
    const branch = gitDefaultBranchForRoot(gitRoot);
    return { root: gitRoot, gitRoot, branch, defaultBranch: branch };
  }

  function gitUpstreamBranchForRoot(gitRoot) {
    try {
      const upstreamRef = execFileSync("git", ["-C", gitRoot, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return upstreamRef || null;
    } catch {
      return null;
    }
  }

  function gitUpstreamBranchForPayload(payload) {
    const target = resolveGitTargetPath(payload);
    if (!target) return { branch: null, upstreamRef: null };
    const gitRoot = findGitRoot(target);
    if (!gitRoot) return { root: realpathSafe(target) || path.resolve(target), gitRoot: null, branch: null, upstreamRef: null };
    return {
      root: gitRoot,
      gitRoot,
      branch: currentGitBranchForRoot(gitRoot),
      upstreamRef: gitUpstreamBranchForRoot(gitRoot),
    };
  }

  function gitBranchAheadCountForPayload(payload) {
    const target = resolveGitTargetPath(payload);
    if (!target) return { gitRoot: null, branch: null, defaultBranch: null, upstreamRef: null, commitsAhead: 0 };
    const gitRoot = findGitRoot(target);
    if (!gitRoot) {
      return {
        root: realpathSafe(target) || path.resolve(target),
        gitRoot: null,
        branch: null,
        defaultBranch: null,
        upstreamRef: null,
        commitsAhead: 0,
      };
    }
    const branch = currentGitBranchForRoot(gitRoot);
    const defaultBranch = gitDefaultBranchForRoot(gitRoot);
    const upstreamRef = gitUpstreamBranchForRoot(gitRoot);
    let commitsAhead = 0;
    if (upstreamRef && gitHasHeadCommit(gitRoot)) {
      try {
        const raw = execFileSync("git", ["-C", gitRoot, "rev-list", "--count", `${upstreamRef}..HEAD`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        commitsAhead = Number.parseInt(raw, 10) || 0;
      } catch {
        commitsAhead = 0;
      }
    }
    return { root: gitRoot, gitRoot, branch, defaultBranch, upstreamRef, commitsAhead };
  }

  /** branch-diff-stats IPC：统计当前分支相对 base branch 的增删行数。 */
  function gitBranchDiffStatsForPayload(payload) {
    const target = resolveGitTargetPath(payload);
    if (!target) return null;
    const gitRoot = findGitRoot(target);
    if (!gitRoot || !gitHasHeadCommit(gitRoot)) return null;

    const params =
      payload && typeof payload === "object" && payload.params && typeof payload.params === "object"
        ? payload.params
        : payload;
    const explicitBase =
      params && typeof params === "object" && typeof params.baseBranch === "string"
        ? params.baseBranch.trim()
        : "";
    const baseBranch = explicitBase || baseBranchForPayload(params).baseBranch || gitUpstreamBranchForRoot(gitRoot);
    const candidates = [];
    if (baseBranch) {
      candidates.push(baseBranch);
      if (!baseBranch.includes("/") && baseBranch !== "HEAD") candidates.push(`origin/${baseBranch}`);
    }
    const upstreamRef = gitUpstreamBranchForRoot(gitRoot);
    if (upstreamRef) candidates.push(upstreamRef);

    let raw = null;
    for (const candidate of [...new Set(candidates.filter(Boolean))]) {
      try {
        raw = execFileSync("git", ["-C", gitRoot, "diff", "--numstat", `${candidate}...HEAD`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5000,
        });
        break;
      } catch {}
    }
    if (raw == null) {
      try {
        raw = execFileSync("git", ["-C", gitRoot, "diff", "--numstat", "HEAD"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5000,
        });
      } catch {
        return null;
      }
    }

    let additions = 0;
    let deletions = 0;
    let filesChanged = 0;
    for (const line of String(raw).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [added, removed] = line.split(/\t/);
      const addedCount = Number.parseInt(added, 10);
      const removedCount = Number.parseInt(removed, 10);
      if (Number.isFinite(addedCount)) additions += addedCount;
      if (Number.isFinite(removedCount)) deletions += removedCount;
      filesChanged += 1;
    }
    return { additions, deletions, filesChanged };
  }

  /** 执行官方 git worker 同款本地 git 命令；所有输出只在内存中处理。 */
  function gitExec(gitRoot, args, options = {}) {
    try {
      const stdout = execFileSync("git", ["-C", gitRoot, ...args], {
        encoding: options.encoding || "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: options.timeoutMs || GIT_OPERATION_TIMEOUT_MS,
        maxBuffer: options.maxBuffer || GIT_DIFF_MAX_BUFFER_BYTES,
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      });
      return { success: true, stdout: String(stdout || ""), code: 0 };
    } catch (error) {
      return {
        success: false,
        stdout: error && error.stdout ? String(error.stdout) : "",
        stderr: error && error.stderr ? String(error.stderr) : "",
        code: typeof error.status === "number" ? error.status : 1,
      };
    }
  }

  function normalizeGitRelativePath(gitRoot, filePath) {
    if (typeof filePath !== "string" || !filePath.trim()) return null;
    const stripped = filePath.trim().replace(/^([ab])[\\/]/, "");
    const absolute = path.isAbsolute(stripped) ? stripped : path.resolve(gitRoot, stripped);
    const resolvedRoot = realpathSafe(gitRoot) || path.resolve(gitRoot);
    const resolvedCandidate = realpathSafe(absolute) || path.resolve(absolute);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return relative.split(path.sep).join("/");
  }

  function uniqueGitPaths(paths) {
    const seen = new Set();
    const result = [];
    for (const item of Array.isArray(paths) ? paths : []) {
      if (typeof item !== "string" || !item.trim()) continue;
      const normalized = item.trim().replace(/^([ab])[\\/]/, "").split(/[\\/]+/).filter(Boolean).join("/");
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
    }
    return result;
  }

  function appendPathspec(args, paths) {
    const pathspecs = uniqueGitPaths(paths);
    return pathspecs.length > 0 ? [...args, "--", ...pathspecs] : args;
  }

  function changeKindFromStatus(status) {
    const code = String(status || "")[0];
    if (code === "A") return "added";
    if (code === "D") return "deleted";
    if (code === "R") return "renamed";
    if (code === "C") return "copied";
    if (code === "T") return "type-changed";
    if (code === "U") return "unmerged";
    return "modified";
  }

  function reviewFileKey(filePath, previousPath) {
    return `${previousPath || ""}\0${filePath || ""}`;
  }

  function parseNameStatusZ(output) {
    const parts = String(output || "").split("\0").filter((part) => part.length > 0);
    const files = [];
    for (let index = 0; index < parts.length; index += 1) {
      const status = parts[index];
      if (!status) break;
      const code = status[0] || "";
      const changeKind = changeKindFromStatus(code);
      if (code === "R" || code === "C") {
        const previousPath = parts[index + 1];
        const filePath = parts[index + 2];
        if (!previousPath || !filePath) break;
        files.push({ additions: null, changeKind, deletions: null, path: filePath, previousPath });
        index += 2;
        continue;
      }
      const filePath = parts[index + 1];
      if (!filePath) break;
      files.push({ additions: null, changeKind, deletions: null, path: filePath, previousPath: null });
      index += 1;
    }
    return files;
  }

  function parseNumstatZ(output) {
    const parts = String(output || "").split("\0").filter((part) => part.length > 0);
    const stats = [];
    for (let index = 0; index < parts.length; index += 1) {
      const line = parts[index];
      if (!line) break;
      const [added, removed, filePath] = line.split("\t");
      if (added == null || removed == null || filePath == null) continue;
      const additions = added === "-" ? null : Number.parseInt(added, 10);
      const deletions = removed === "-" ? null : Number.parseInt(removed, 10);
      if (filePath.length > 0) {
        stats.push({
          additions: Number.isFinite(additions) ? additions : null,
          deletions: Number.isFinite(deletions) ? deletions : null,
          path: filePath,
          previousPath: null,
        });
        continue;
      }
      const previousPath = parts[index + 1];
      const renamedPath = parts[index + 2];
      if (!previousPath || !renamedPath) break;
      stats.push({
        additions: Number.isFinite(additions) ? additions : null,
        deletions: Number.isFinite(deletions) ? deletions : null,
        path: renamedPath,
        previousPath,
      });
      index += 2;
    }
    return stats;
  }

  function parseRawZ(output) {
    const parts = String(output || "").split("\0").filter((part) => part.length > 0);
    const entries = [];
    for (let index = 0; index < parts.length; index += 1) {
      const line = parts[index];
      if (!line) break;
      const match = /^:\d{6} \d{6} ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(?:\d+)?$/.exec(line);
      if (!match) continue;
      const [, oldOid, newOid, status] = match;
      if (status === "R" || status === "C") {
        const previousPath = parts[index + 1];
        const filePath = parts[index + 2];
        if (!previousPath || !filePath) break;
        entries.push({ oldOid, newOid, status, path: filePath, previousPath });
        index += 2;
        continue;
      }
      const filePath = parts[index + 1];
      if (!filePath) break;
      entries.push({ oldOid, newOid, status, path: filePath, previousPath: null });
      index += 1;
    }
    return entries;
  }

  function baseRefForReview(gitRoot, requestedBaseBranch) {
    const candidates = [];
    if (typeof requestedBaseBranch === "string" && requestedBaseBranch.trim()) {
      const trimmed = requestedBaseBranch.trim();
      candidates.push(trimmed);
      if (!trimmed.includes("/") && trimmed !== "HEAD") candidates.push(`origin/${trimmed}`);
    }
    const upstream = gitUpstreamBranchForRoot(gitRoot);
    if (upstream) candidates.push(upstream);
    for (const candidate of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
      candidates.push(candidate);
    }
    for (const candidate of [...new Set(candidates)]) {
      const result = gitExec(gitRoot, ["merge-base", candidate, "HEAD"], { maxBuffer: 1024 * 1024 });
      if (result.success && result.stdout.trim()) return result.stdout.trim();
    }
    return gitHasHeadCommit(gitRoot) ? "HEAD" : null;
  }

  function diffArgsForReviewSource(gitRoot, source, baseBranch) {
    if (source === "staged") return ["--cached"];
    if (source === "branch") {
      const baseRef = baseRefForReview(gitRoot, baseBranch);
      return baseRef ? [baseRef, "HEAD"] : null;
    }
    return [];
  }

  function pathMatchesPathspec(filePath, paths) {
    const normalizedPaths = uniqueGitPaths(paths);
    if (normalizedPaths.length === 0) return true;
    return normalizedPaths.some((entry) => filePath === entry || filePath.startsWith(`${entry}/`));
  }

  function listUntrackedPaths(gitRoot, paths) {
    const result = gitExec(gitRoot, appendPathspec(["ls-files", "--others", "--exclude-standard", "-z"], paths));
    if (!result.success || !result.stdout) return [];
    return result.stdout.split("\0").filter((entry) => entry && pathMatchesPathspec(entry, paths));
  }

  function countTextLinesForFile(filePath) {
    try {
      const stats = fs.statSync(filePath);
      if (!stats.isFile() || stats.size > GIT_FILE_PREVIEW_LIMIT_BYTES) return null;
      const text = fs.readFileSync(filePath, "utf8");
      if (text.length === 0) return 0;
      const lines = text.split(/\r\n|\n|\r/);
      if (lines[lines.length - 1] === "") lines.pop();
      return lines.length;
    } catch {
      return null;
    }
  }

  function untrackedRevisionForFile(gitRoot, filePath) {
    const absolutePath = path.join(gitRoot, filePath);
    try {
      const stats = fs.statSync(absolutePath);
      return `untracked:${stats.size}:${Math.floor(stats.mtimeMs)}`;
    } catch {
      return `untracked:${filePath}`;
    }
  }

  function untrackedReviewFiles(gitRoot, paths) {
    return listUntrackedPaths(gitRoot, paths).map((filePath) => ({
      additions: countTextLinesForFile(path.join(gitRoot, filePath)),
      changeKind: "untracked",
      deletions: 0,
      path: filePath,
      previousPath: null,
      revision: untrackedRevisionForFile(gitRoot, filePath),
    }));
  }

  function reviewMetadataForGitRoot(gitRoot, options = {}) {
    const source = typeof options.source === "string" ? options.source : "unstaged";
    const diffArgs = diffArgsForReviewSource(gitRoot, source, options.baseBranch);
    if (diffArgs == null) return null;
    const hideWhitespace = !!options.hideWhitespace;
    const whitespaceArgs = hideWhitespace ? ["--ignore-all-space"] : [];
    const pathspecs = uniqueGitPaths(options.paths || []);
    const baseArgs = [...GIT_DIFF_BASE_ARGS, ...diffArgs, ...whitespaceArgs, "--find-renames"];
    const nameStatus = gitExec(gitRoot, appendPathspec([...baseArgs, "--name-status", "-z"], pathspecs));
    const numstat = gitExec(gitRoot, appendPathspec([...baseArgs, "--numstat", "-z"], pathspecs));
    const raw = gitExec(gitRoot, appendPathspec([...baseArgs, "--raw", "-z"], pathspecs));
    if (!nameStatus.success || !numstat.success || !raw.success) return null;

    let files = parseNameStatusZ(nameStatus.stdout);
    const stats = new Map(parseNumstatZ(numstat.stdout).map((entry) => [reviewFileKey(entry.path, entry.previousPath), entry]));
    const rawEntries = new Map(parseRawZ(raw.stdout).map((entry) => [reviewFileKey(entry.path, entry.previousPath), entry]));
    if (hideWhitespace) {
      files = files.filter((entry) => stats.has(reviewFileKey(entry.path, entry.previousPath)));
    }

    const includeUntracked = options.includeUntrackedFiles !== false && source !== "staged";
    if (includeUntracked) {
      const trackedPaths = new Set(files.map((entry) => entry.path));
      for (const entry of untrackedReviewFiles(gitRoot, pathspecs)) {
        if (!trackedPaths.has(entry.path)) files.push(entry);
      }
    }

    return files.map((entry) => {
      const key = reviewFileKey(entry.path, entry.previousPath);
      const stat = stats.get(key) || null;
      const rawEntry = rawEntries.get(key) || null;
      let revision;
      if (entry.changeKind === "untracked") {
        revision = entry.revision || untrackedRevisionForFile(gitRoot, entry.path);
      } else if (rawEntry) {
        if (source === "staged" || rawEntry.status === "D") {
          revision = `${source}:${rawEntry.status}:${rawEntry.oldOid}:${rawEntry.newOid}`;
        } else {
          try {
            const fileStats = fs.statSync(path.join(gitRoot, rawEntry.path));
            revision = `${source}:${rawEntry.status}:${rawEntry.oldOid}:worktree:${fileStats.size}:${Math.floor(fileStats.mtimeMs)}`;
          } catch {
            revision = `${source}:${rawEntry.status}:${rawEntry.oldOid}:${rawEntry.newOid}`;
          }
        }
      } else {
        revision = `${source}:${entry.changeKind}:${entry.previousPath || ""}:${entry.path}`;
      }
      return {
        ...entry,
        additions: entry.additions ?? stat?.additions ?? null,
        deletions: entry.deletions ?? stat?.deletions ?? null,
        revision,
      };
    });
  }

  function gitStatusStageCounts(gitRoot) {
    const result = gitExec(gitRoot, ["status", "--porcelain=v1", "-z"]);
    if (!result.success) return { stagedFileCount: 0, unstagedFileCount: 0, untrackedFileCount: 0 };
    const parts = result.stdout.split("\0").filter(Boolean);
    let stagedFileCount = 0;
    let unstagedFileCount = 0;
    let untrackedFileCount = 0;
    for (let index = 0; index < parts.length; index += 1) {
      const entry = parts[index];
      if (!entry || entry.length < 3) continue;
      const x = entry[0];
      const y = entry[1];
      if (x === "?" && y === "?") {
        untrackedFileCount += 1;
        continue;
      }
      if (x === "R" || x === "C") index += 1;
      if (x && x !== " " && x !== "?") stagedFileCount += 1;
      if (y && y !== " ") unstagedFileCount += 1;
    }
    return { stagedFileCount, unstagedFileCount, untrackedFileCount };
  }

  function reviewSummaryForPayload(payload) {
    const params = payloadParams(payload);
    const source = params && typeof params.source === "string" ? params.source : "unstaged";
    const target = resolveGitTargetPath(params);
    if (!target) return { type: "error", source };
    const gitRoot = findGitRoot(target);
    if (!gitRoot) return { type: "error", source };
    const files = reviewMetadataForGitRoot(gitRoot, {
      source,
      includeUntrackedFiles: params && params.includeUntrackedFiles,
      baseBranch: params && params.baseBranch,
      paths: params && params.paths,
      hideWhitespace: params && params.hideWhitespace,
    });
    if (!files) return { type: "error", source };
    return {
      type: "success",
      files,
      source,
      stageCounts: gitStatusStageCounts(gitRoot),
    };
  }

  function reviewPathSummaryForPayload(payload) {
    const params = payloadParams(payload);
    const source = params && typeof params.source === "string" ? params.source : "unstaged";
    const target = resolveGitTargetPath(params);
    if (!target) return { type: "error", source };
    const gitRoot = findGitRoot(target);
    if (!gitRoot) return { type: "error", source };
    const files = reviewMetadataForGitRoot(gitRoot, {
      source,
      includeUntrackedFiles: true,
      baseBranch: params && params.baseBranch,
      paths: params && params.paths,
      hideWhitespace: params && params.hideWhitespace,
    });
    return files ? { type: "success", files, source } : { type: "error", source };
  }

  function parseDiffHeader(line) {
    if (!line.startsWith("diff --git ")) return null;
    const body = line.slice("diff --git ".length);
    const marker = " b/";
    const markerIndex = body.lastIndexOf(marker);
    if (markerIndex < 0) return null;
    const oldPath = body.slice(0, markerIndex).replace(/^a\//, "");
    const newPath = body.slice(markerIndex + marker.length);
    return { oldPath, newPath };
  }

  function splitDiffByPath(diffText) {
    const map = new Map();
    const matches = Array.from(String(diffText || "").matchAll(/^diff --git .*$/gm));
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index];
      const header = parseDiffHeader(match[0]);
      if (!header) continue;
      const start = match.index || 0;
      const end = index + 1 < matches.length ? matches[index + 1].index || diffText.length : diffText.length;
      const diff = diffText.slice(start, end);
      const entry = { type: "success", diff, diffBytes: Buffer.byteLength(diff, "utf8") };
      map.set(header.oldPath, entry);
      map.set(header.newPath, entry);
    }
    return map;
  }

  function escapePatchLine(line) {
    return String(line).replace(/\r?\n$/, "");
  }

  function untrackedFileDiff(gitRoot, filePath) {
    const absolutePath = path.join(gitRoot, filePath);
    try {
      const stats = fs.statSync(absolutePath);
      if (!stats.isFile() || stats.size > GIT_FILE_PREVIEW_LIMIT_BYTES) {
        return { type: "error", error: { type: "too-large", limitBytes: GIT_FILE_PREVIEW_LIMIT_BYTES } };
      }
      const text = fs.readFileSync(absolutePath, "utf8");
      const lines = fileTextToLines(text);
      const header = [
        `diff --git a/${filePath} b/${filePath}`,
        "new file mode 100644",
        "index 0000000..0000000",
        "--- /dev/null",
        `+++ b/${filePath}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${escapePatchLine(line)}`),
      ];
      const diff = `${header.join("\n")}\n`;
      return { type: "success", diff, diffBytes: Buffer.byteLength(diff, "utf8") };
    } catch {
      return { type: "error", error: { type: "unknown" } };
    }
  }

  function reviewDiffForPayload(payload) {
    const params = payloadParams(payload);
    const source = params && typeof params.source === "string" ? params.source : "unstaged";
    const requestedFiles = Array.isArray(params && params.files) ? params.files : [];
    const target = resolveGitTargetPath(params);
    const errorResult = Object.fromEntries(
      requestedFiles.map((entry) => [entry && entry.path ? entry.path : "", { type: "error", error: { type: "unknown" } }])
    );
    if (!target) return { source, diffs: errorResult };
    const gitRoot = findGitRoot(target);
    if (!gitRoot) return { source, diffs: errorResult };
    const files = requestedFiles
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const filePath = normalizeGitRelativePath(gitRoot, entry.path);
        if (!filePath) return null;
        const previousPath = entry.previousPath == null ? null : normalizeGitRelativePath(gitRoot, entry.previousPath);
        return { ...entry, path: filePath, previousPath, requestPath: entry.path };
      })
      .filter(Boolean);
    if (files.length === 0) return { source, diffs: {} };
    const diffArgs = diffArgsForReviewSource(gitRoot, source, params && params.baseBranch);
    if (diffArgs == null) return { source, diffs: errorResult };
    const diffPaths = [...new Set(files.flatMap((entry) => (entry.previousPath ? [entry.previousPath, entry.path] : [entry.path])))];
    const whitespaceArgs = params && params.hideWhitespace ? ["--ignore-all-space"] : [];
    const result = gitExec(
      gitRoot,
      appendPathspec([...GIT_DIFF_BASE_ARGS, ...diffArgs, ...whitespaceArgs, "--find-renames"], diffPaths)
    );
    const diffMap = result.success ? splitDiffByPath(result.stdout) : new Map();
    const untracked = new Set(source !== "staged" ? listUntrackedPaths(gitRoot, diffPaths) : []);
    const diffs = {};
    for (const entry of files) {
      if (diffMap.has(entry.path)) {
        diffs[entry.requestPath] = diffMap.get(entry.path);
      } else if (entry.previousPath && diffMap.has(entry.previousPath)) {
        diffs[entry.requestPath] = diffMap.get(entry.previousPath);
      } else if (untracked.has(entry.path) || entry.changeKind === "untracked") {
        diffs[entry.requestPath] = untrackedFileDiff(gitRoot, entry.path);
      } else if (params && params.hideWhitespace) {
        diffs[entry.requestPath] = { type: "success", diff: "", diffBytes: 0 };
      } else {
        diffs[entry.requestPath] = { type: "error", error: { type: result.success ? "unknown" : "diff-too-large", limitBytes: GIT_DIFF_MAX_BUFFER_BYTES } };
      }
    }
    return { source, diffs };
  }

  function reviewPatchForPayload(payload) {
    const params = payloadParams(payload);
    const source = params && typeof params.source === "string" ? params.source : "unstaged";
    const target = resolveGitTargetPath(params);
    if (!target) return { source, diff: { type: "error", error: { type: "unknown" } } };
    const gitRoot = findGitRoot(target);
    if (!gitRoot) return { source, diff: { type: "error", error: { type: "unknown" } } };
    const diffArgs = diffArgsForReviewSource(gitRoot, source, params && params.baseBranch);
    if (diffArgs == null) return { source, diff: { type: "error", error: { type: "unknown" } } };
    const result = gitExec(gitRoot, [...GIT_DIFF_BASE_ARGS, ...diffArgs], { maxBuffer: GIT_DIFF_MAX_BUFFER_BYTES });
    if (!result.success) return { source, diff: { type: "error", error: { type: "unknown" } } };
    let unifiedDiff = result.stdout;
    if (source !== "staged") {
      const untrackedDiffs = untrackedReviewFiles(gitRoot, []).map((entry) => untrackedFileDiff(gitRoot, entry.path));
      for (const diff of untrackedDiffs) {
        if (diff.type === "success") unifiedDiff += diff.diff;
      }
    }
    return {
      source,
      diff: {
        type: "success",
        unifiedDiff,
        unifiedDiffBytes: Buffer.byteLength(unifiedDiff, "utf8"),
      },
    };
  }

  function gitStatusSummaryForPayload(payload) {
    const status = gitStatusForPayload(payload);
    if (!status) return { isGitRepo: false, branch: null, clean: true, entries: [] };
    return {
      ...status,
      hasUncommittedChanges: Array.isArray(status.entries) ? status.entries.length > 0 : !status.clean,
    };
  }

  function gitSubmodulePathsForPayload(payload) {
    const target = resolveGitTargetPath(payload);
    if (!target) return { root: null, paths: [] };
    const gitRoot = findGitRoot(target);
    if (!gitRoot) return { root: realpathSafe(target) || path.resolve(target), paths: [] };
    try {
      const raw = execFileSync("git", ["-C", gitRoot, "config", "--file", ".gitmodules", "--get-regexp", "path"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const paths = raw
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/).slice(1).join(" "))
        .filter(Boolean);
      return { root: gitRoot, paths };
    } catch {
      return { root: gitRoot, paths: [] };
    }
  }

  /** cat-file worker：补全官方 diff 组件需要的完整文件行内容。 */
  function gitCatFileForPayload(payload) {
    const params = payloadParams(payload);
    const cwd = params && typeof params === "object" && typeof params.cwd === "string" ? params.cwd : resolveGitTargetPath(params);
    const filePath = params && typeof params === "object" && typeof params.path === "string" ? params.path : "";
    const oid = params && typeof params === "object" && typeof params.oid === "string" ? params.oid.trim() : null;
    const fallbackToDisk = !!(params && typeof params === "object" && params.fallbackToDisk);
    const gitRoot = cwd ? findGitRoot(cwd) : null;

    if (cwd && oid && isBlobObjectId(oid)) {
      const snapshot = getReviewSnapshot(oid);
      if (snapshot) {
        return { type: "success", lines: snapshot.lines };
      }
      if (gitRoot) {
        try {
          const sizeOutput = execFileSync("git", ["-C", gitRoot, "cat-file", "-s", oid], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: GIT_OPERATION_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
            env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
          });
          const sizeBytes = Number.parseInt(String(sizeOutput).trim(), 10);
          if (Number.isFinite(sizeBytes) && sizeBytes > GIT_FILE_PREVIEW_LIMIT_BYTES) {
            return { type: "error", error: { type: "too-large", limitBytes: GIT_FILE_PREVIEW_LIMIT_BYTES } };
          }
          const output = execFileSync("git", ["-C", gitRoot, "cat-file", "-p", oid], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: GIT_OPERATION_TIMEOUT_MS,
            maxBuffer: GIT_FILE_PREVIEW_LIMIT_BYTES,
            env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
          });
          return { type: "success", lines: fileTextToLines(output) };
        } catch {
          // Fall through to disk fallback when the renderer explicitly allows it.
        }
      }
    }

    if (fallbackToDisk && cwd && filePath) {
      const lines = readWorkspaceFileLines(gitRoot || cwd, filePath);
      if (lines && lines.error) return { type: "error", error: lines.error };
      if (lines) return { type: "success", lines };
    }

    return { type: "error", error: { type: "not-found" } };
  }

  /** 解析 git status --porcelain 输出为 renderer 更容易消费的结构。 */
  function parseGitStatusLines(lines) {
    return lines
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        if (line.startsWith("##")) {
          return { kind: "branch", raw: line };
        }
        const status = line.slice(0, 2);
        const filePath = line.slice(3);
        return {
          kind: "file",
          status,
          path: filePath,
          staged: status[0] !== " " && status[0] !== "?",
          unstaged: status[1] !== " ",
          untracked: status === "??",
        };
      });
  }

  /** git:status 的本地快速实现，失败时上层会再尝试 app-server。 */
  function gitStatusForPayload(payload) {
    const requestedPath =
      (payload && typeof payload === "object" && (payload.path || payload.root || payload.rootPath || payload.projectPath)) ||
      null;
    const target = requestedPath || parseWorkspaceRoots()[0] || null;
    if (!target) return null;

    const gitRoot = findGitRoot(target);
    if (!gitRoot) {
      return {
        root: realpathSafe(target) || path.resolve(target),
        isGitRepo: false,
        branch: null,
        clean: true,
        entries: [],
      };
    }

    try {
      const raw = execFileSync("git", ["-C", gitRoot, "status", "--short", "--branch"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const lines = raw.split(/\r?\n/).filter(Boolean);
      const entries = parseGitStatusLines(lines);
      const branchLine = entries.find((entry) => entry.kind === "branch");
      const branch = branchLine ? normalizeBranchName(branchLine.raw) : null;
      const fileEntries = entries.filter((entry) => entry.kind === "file");
      return {
        root: gitRoot,
        isGitRepo: true,
        branch,
        clean: fileEntries.length === 0,
        entries: fileEntries,
      };
    } catch {
      return {
        root: gitRoot,
        isGitRepo: true,
        branch: null,
        clean: true,
        entries: [],
      };
    }
  }

  /** 执行本机命令并只返回结果，stdout/stderr 不落日志，避免泄露用户环境细节。 */
  function runQuietCommand(command, args, timeoutMs) {
    try {
      return {
        ok: true,
        stdout: execFileSync(command, args, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: timeoutMs,
        }),
      };
    } catch {
      return { ok: false, stdout: "" };
    }
  }

  /** gh-cli-status IPC：检查 GitHub CLI 是否安装，以及当前本机是否已登录。 */
  function ghCliStatus() {
    const versionResult = runQuietCommand("gh", ["--version"], 1500);
    if (!versionResult.ok) {
      return { isInstalled: false, isAuthenticated: false, version: null };
    }
    const authResult = runQuietCommand("gh", ["auth", "status", "--hostname", "github.com"], 2500);
    const version = versionResult.stdout.split(/\r?\n/).find(Boolean) || null;
    return {
      isInstalled: true,
      isAuthenticated: authResult.ok,
      version,
    };
  }


  /** Git worker 的业务方法分发，复用本文件中的本地 git 实现。 */
  function handleGitWorkerMethod(method, params) {
    switch (method) {
      case "stable-metadata":
        return gitStableMetadataForPayload(params);
      case "watch-repo":
      case "unwatch-repo":
        return true;
      case "invalidate-untracked-paths-cache":
        return true;
      case "cat-file":
        return gitCatFileForPayload(params);
      case "current-branch":
        return currentBranchForPayload(params);
      case "has-head-commit": {
        const target = resolveGitTargetPath(params);
        const gitRoot = target ? findGitRoot(target) : null;
        return { hasHeadCommit: !!(gitRoot && gitHasHeadCommit(gitRoot)) };
      }
      case "upstream-branch":
        return gitUpstreamBranchForPayload(params);
      case "branch-ahead-count":
        return gitBranchAheadCountForPayload(params);
      case "branch-diff-stats":
        return gitBranchDiffStatsForPayload(params);
      case "default-branch":
        return gitDefaultBranchForPayload(params);
      case "status-summary":
        return gitStatusSummaryForPayload(params);
      case "review-summary":
        return reviewSummaryForPayload(params);
      case "review-path-summary":
        return reviewPathSummaryForPayload(params);
      case "review-diff":
        return reviewDiffForPayload(params);
      case "review-patch":
        return reviewPatchForPayload(params);
      case "submodule-paths":
        return gitSubmodulePathsForPayload(params);
      case "recent-branches":
      case "search-branches": {
        const result = recentBranchesForPayload(params);
        const query =
          params && typeof params === "object" && typeof params.query === "string"
            ? params.query.trim().toLowerCase()
            : "";
        if (!query) return result;
        return {
          ...result,
          branches: result.branches.filter((branch) => branch.toLowerCase().includes(query)),
        };
      }
      case "git-create-branch":
        return createGitBranchForPayload(params);
      case "git-checkout-branch":
        return checkoutGitBranchForPayload(params);
      case "base-branch":
        return baseBranchForPayload(params);
      default:
        throw new Error(`Unsupported git worker method: ${method}`);
    }
  }


  return {
    baseBranchForPayload,
    checkoutGitBranchForPayload,
    createGitBranchForPayload,
    currentBranchForPayload,
    ghCliStatus,
    gitStableMetadataForPayload,
    gitStatusForPayload,
    handleGitWorkerMethod,
    recentBranchesForPayload,
  };
}

module.exports = {
  createGitIpcHandlers,
};
