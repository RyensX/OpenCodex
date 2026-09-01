const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");
const pointSourceRoot = path.join(projectRoot, "gateway", "src", "modification");
const pluginRoot = path.join(projectRoot, "web-shell", "plugins");
const browserProviderRoot = path.join(projectRoot, "web-shell", "internal", "providers");
const FORBIDDEN_POINT_IDENTIFIERS = new Set([
  "document",
  "window",
  "globalThis",
  "navigator",
  "localStorage",
  "process",
  "fetch",
  "WebSocket",
  "MutationObserver",
  "HTMLElement",
  "require",
]);

function filesBelow(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(entryPath) : [entryPath];
  });
}

const violations = [];
for (const file of filesBelow(pointSourceRoot).filter((entry) => entry.endsWith(".ts"))) {
  // contracts 只声明虚拟类型；浏览器真实 Provider 位于 web-shell/src，不得反向渗入修改点工程。
  const source = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const forbidden = new Set();
  const visit = (node) => {
    if (ts.isIdentifier(node) && FORBIDDEN_POINT_IDENTIFIERS.has(node.text)) {
      const parent = node.parent;
      const isRuntimeAccess =
        (ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
        (ts.isElementAccessExpression(parent) && parent.expression === node) ||
        (ts.isCallExpression(parent) && parent.expression === node) ||
        (ts.isNewExpression(parent) && parent.expression === node);
      if (isRuntimeAccess) forbidden.add(node.text);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleId = node.moduleSpecifier.text;
      if (/^(?:node:)?(?:fs|child_process|electron)$/.test(moduleId) || moduleId.includes("/providers/")) {
        forbidden.add(`import:${moduleId}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const item of forbidden) violations.push(`${path.relative(projectRoot, file)} 使用受限标识 ${item}`);
}

for (const file of filesBelow(pluginRoot)) {
  if (path.basename(file) === "index.js") {
    violations.push(`${path.relative(projectRoot, file)} 仍是可直接执行的旧式插件入口`);
  }
}

for (const file of filesBelow(browserProviderRoot).filter((entry) => entry.endsWith(".js"))) {
  const source = fs.readFileSync(file, "utf8");
  // Provider 可以操作真实 DOM，但 Observer 和全局事件的所有权必须交给共享浏览器宿主。
  if (/new\s+(?:w\.)?MutationObserver\b/.test(source)) {
    violations.push(`${path.relative(projectRoot, file)} 绕过共享 DOM Observer`);
  }
  if (/\b(?:document|window|w)\.addEventListener\s*\(/.test(source)) {
    violations.push(`${path.relative(projectRoot, file)} 绕过共享全局事件 Provider`);
  }
  if (
    /\bw\.(?:setTimeout|clearTimeout|setInterval|clearInterval|requestAnimationFrame|cancelAnimationFrame)\s*\(/.test(source) ||
    /(?<![.\w])(?:setTimeout|clearTimeout|setInterval|clearInterval|requestAnimationFrame|cancelAnimationFrame)\s*\(/.test(source)
  ) {
    violations.push(`${path.relative(projectRoot, file)} 绕过 Provider Scheduler 生命周期`);
  }
  if (/OpenCodexRuntimeCompatibility/.test(source)) {
    violations.push(`${path.relative(projectRoot, file)} 仍由业务代码手工写兼容状态`);
  }
}

for (const root of [
  path.join(projectRoot, "gateway", "runtime"),
  path.join(projectRoot, "gateway", "runner"),
  path.join(projectRoot, "gateway", "src"),
  path.join(projectRoot, "launcher"),
]) {
  for (const file of filesBelow(root).filter((entry) => /\.(?:cjs|js|ts)$/.test(entry))) {
    if (file.includes(`${path.sep}runtime${path.sep}compatibility${path.sep}`)) continue;
    const source = fs.readFileSync(file, "utf8");
    if (/\.(?:installPoint|bindCapability|recordHit|browserReport)\s*\(/.test(source)) {
      violations.push(`${path.relative(projectRoot, file)} 绕过生产 Kernel 直接写兼容状态`);
    }
    if (/\.registry\.(?:disablePoint|setPointsEnabled|useFallback|beginResolution)\s*\(/.test(source)) {
      violations.push(`${path.relative(projectRoot, file)} 绕过生产 Provider 直接修改 Registry 生命周期`);
    }
  }
}

for (const root of [
  path.join(projectRoot, "gateway", "runtime"),
  path.join(projectRoot, "gateway", "runner"),
  path.join(projectRoot, "gateway", "src"),
  path.join(projectRoot, "launcher"),
  path.join(projectRoot, "web-shell"),
]) {
  const removedStrategyProperty = ["strategy", "Id"].join("");
  for (const file of filesBelow(root).filter((entry) => /\.(?:cjs|js|ts)$/.test(entry))) {
    if (new RegExp(`\\b${removedStrategyProperty}\\b`).test(fs.readFileSync(file, "utf8"))) {
      violations.push(`${path.relative(projectRoot, file)} 仍使用自由字符串执行策略`);
    }
  }
}

if (violations.length > 0) {
  throw new Error(`虚拟骨架边界检查失败：\n${violations.join("\n")}`);
}

const catalogPath = path.join(projectRoot, "gateway", "dist", "modification", "catalog.js");
if (!fs.existsSync(catalogPath)) throw new Error("缺少已编译的虚拟骨架目录");
const catalog = require(catalogPath);
if (catalog.POINT_DEFINITIONS.length !== 103) throw new Error("修改点迁移矩阵不是 103 项");
if (catalog.POINT_TARGETS.length !== 103 || new Set(catalog.POINT_TARGETS).size !== 103) {
  throw new Error("103 个修改点没有各自独立的强类型语义目标");
}
if (catalog.MIGRATION_MATRIX.length !== 103 || catalog.MIGRATION_MATRIX.some((entry) => {
  return entry.migrationStatus !== "migrated" || !entry.groupId || !entry.targetId || !entry.host;
})) {
  throw new Error("103 点迁移矩阵仍有 legacy 或 unassigned 项");
}
if (catalog.POINT_DEFINITIONS.some((point) => !point.group || point.contributions.length === 0)) {
  throw new Error("存在未分组或没有适配器的修改点");
}
if (catalog.POINT_DEFINITIONS.some((point) => point.contributions.some((item) => {
  return !item.declaration?.target ||
    Object.prototype.hasOwnProperty.call(item.declaration, "pointId") ||
    Object.prototype.hasOwnProperty.call(item.declaration, "implementation");
}))) {
  throw new Error("修改点仍在绑定实现或自由字符串，而不是强类型语义目标");
}
