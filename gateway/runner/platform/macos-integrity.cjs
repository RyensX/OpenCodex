const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const asar = require("@electron/asar");
const { withPhysicalAsarAccess } = require("../shared/fs-utils.cjs");

// Electron 的 v1 摘要槽格式见 shell/common/asar/integrity_digest.mm。
// 保留校验开关，只把官方应用的摘要替换为本次 runner 的摘要。
const SENTINEL = Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A");

function refreshMacIntegrity(frameworksDir, runnerAsarPath) {
  const header = withPhysicalAsarAccess(() => asar.getRawHeader(runnerAsarPath).headerString);
  const headerHash = crypto.createHash("sha256").update(header).digest("hex");
  const digest = crypto.createHash("sha256").update(`Resources/app.asarSHA256${headerHash}`).digest();
  const root = fs.realpathSync(frameworksDir);
  const changed = [];
  for (const name of fs.readdirSync(frameworksDir)) {
    if (!name.endsWith(".framework")) continue;
    const candidate = path.join(frameworksDir, name, name.slice(0, -10));
    if (!fs.existsSync(candidate)) continue;
    const binaryPath = fs.realpathSync(candidate);
    // 旧复制方式可能把相对链接变成指向 /Applications 的绝对链接，绝不沿它写入。
    if (!binaryPath.startsWith(root + path.sep)) {
      throw new Error(`Runner framework escapes its cache directory: ${name}`);
    }
    const binary = fs.readFileSync(binaryPath);
    let dirty = false;
    // Universal 二进制可能有多个架构，各架构的摘要都必须一致。
    for (let offset = binary.indexOf(SENTINEL); offset !== -1; offset = binary.indexOf(SENTINEL, offset + 66)) {
      if (offset + 66 > binary.length) throw new Error(`Truncated integrity digest: ${name}`);
      if (binary[offset + 32] === 0) continue;
      if (binary[offset + 33] !== 1) throw new Error(`Unsupported integrity digest version: ${name}`);
      if (!binary.subarray(offset + 34, offset + 66).equals(digest)) {
        digest.copy(binary, offset + 34);
        dirty = true;
      }
    }
    if (dirty) {
      fs.writeFileSync(binaryPath, binary);
      changed.push(binaryPath);
    }
  }
  return changed;
}

module.exports = { refreshMacIntegrity };
