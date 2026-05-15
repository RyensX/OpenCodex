// @ts-nocheck
export {};

const fs = require("fs");
const path = require("path");

function createRecommendedSkillsIpcHandlers(deps) {
  const CODEX_HOME = deps.codexHome;
  const PROJECT_ROOT = deps.projectRoot;
  const activeWorkspaceRootPaths = deps.activeWorkspaceRootPaths;
  const parseWorkspaceRoots = deps.parseWorkspaceRoots;
  const realpathSafe = deps.realpathSafe;

  /** recommended skills 默认仓库目录。 */
  function defaultRecommendedSkillRepoRoot(payload) {
    const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
    const explicitRoot =
      params && typeof params === "object" && typeof params.repoRoot === "string" && params.repoRoot.trim()
        ? params.repoRoot.trim()
        : null;
    if (explicitRoot) return path.resolve(explicitRoot);
    const workspaceRoot =
      activeWorkspaceRootPaths().find((root) => typeof root === "string" && root.trim()) ||
      parseWorkspaceRoots().find((root) => typeof root === "string" && root.trim()) ||
      PROJECT_ROOT;
    return path.join(workspaceRoot, "vendor_imports", "skills");
  }
  
  /** 从 SKILL.md 提取简短描述。 */
  function skillMarkdownDescription(markdown) {
    const lines = String(markdown || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    const firstParagraph = [];
    for (const line of lines) {
      if (line.startsWith("---")) continue;
      if (line.startsWith("- ")) break;
      firstParagraph.push(line.replace(/^description:\s*/i, ""));
      if (firstParagraph.join(" ").length > 240) break;
    }
    return firstParagraph.join(" ").trim().slice(0, 500);
  }
  
  /** 读取单个推荐 skill 的元信息。 */
  function readRecommendedSkill(skillDir) {
    const skillPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillPath)) return null;
    const markdown = fs.readFileSync(skillPath, "utf8");
    const name = path.basename(skillDir);
    const heading = markdown.match(/^#\s+(.+)$/m);
    const displayName = heading ? heading[1].trim() : name;
    const description = skillMarkdownDescription(markdown) || displayName;
    return {
      id: name,
      name: displayName,
      description,
      shortDescription: description.length > 160 ? `${description.slice(0, 157)}...` : description,
      repoPath: skillDir,
      path: skillPath,
    };
  }
  
  /** recommended-skills IPC 的本地实现。 */
  function listRecommendedSkills(payload) {
    const repoRoot = defaultRecommendedSkillRepoRoot(payload);
    const repoRootReal = realpathSafe(repoRoot);
    if (!repoRootReal || !fs.existsSync(repoRootReal)) {
      return { repoRoot, skills: [], error: null };
    }
    const skills = [];
    for (const entry of fs.readdirSync(repoRootReal, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skill = readRecommendedSkill(path.join(repoRootReal, entry.name));
      if (skill) skills.push(skill);
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));
    return { repoRoot, skills, error: null };
  }
  
  /** 安装推荐 skill 到 CODEX_HOME/skills。 */
  function installRecommendedSkill(payload) {
    const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
    const repoPath =
      params && typeof params === "object" && typeof params.repoPath === "string" ? params.repoPath : null;
    const skillId =
      params && typeof params === "object" && typeof params.skillId === "string" ? params.skillId : null;
    if (!repoPath || !skillId) {
      throw new Error("Missing recommended skill repoPath or skillId");
    }
    const sourceDir = fs.existsSync(path.join(repoPath, "SKILL.md")) ? repoPath : path.dirname(repoPath);
    const sourceReal = realpathSafe(sourceDir);
    const repoRootReal = realpathSafe(defaultRecommendedSkillRepoRoot(payload));
    if (!sourceReal || !repoRootReal) throw new Error("Recommended skill source does not exist");
    const rel = path.relative(repoRootReal, sourceReal);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("Recommended skill source is outside the configured repo root");
    }
    const installRoot =
      params && typeof params === "object" && typeof params.installRoot === "string" && params.installRoot.trim()
        ? params.installRoot.trim()
        : path.join(CODEX_HOME, "skills");
    const installRootReal = fs.existsSync(installRoot) ? realpathSafe(installRoot) : path.resolve(installRoot);
    const defaultInstallRoot = path.join(CODEX_HOME, "skills");
    const targetDir = path.join(installRootReal, path.basename(sourceReal));
    const targetParent = path.dirname(targetDir);
    const defaultRootReal = fs.existsSync(defaultInstallRoot) ? realpathSafe(defaultInstallRoot) : path.resolve(defaultInstallRoot);
    const rootRel = path.relative(defaultRootReal, installRootReal);
    if (rootRel.startsWith("..") || path.isAbsolute(rootRel)) {
      throw new Error("Recommended skills can only be installed under the Codex skills directory");
    }
    fs.mkdirSync(targetParent, { recursive: true });
    if (!fs.existsSync(targetDir)) {
      fs.cpSync(sourceReal, targetDir, { recursive: true, force: false, errorOnExist: true });
    }
    return { success: true, path: path.join(targetDir, "SKILL.md") };
  }

  return {
    installRecommendedSkill,
    listRecommendedSkills,
  };
}

module.exports = {
  createRecommendedSkillsIpcHandlers,
};
