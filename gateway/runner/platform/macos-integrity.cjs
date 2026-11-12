const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SENTINEL = Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A");

function patchIntegrityDigest(binary, headerHash) {
  // Electron 按路径、算法、header 哈希依次计算摘要，不使用 JSON 或分隔符。
  const digest = crypto.createHash("sha256")
    .update("Resources/app.asar").update("SHA256").update(headerHash).digest();
  const offsets = [];
  for (let offset = binary.indexOf(SENTINEL); offset !== -1; offset = binary.indexOf(SENTINEL, offset + SENTINEL.length)) {
    const slot = offset + SENTINEL.length;
    if (slot + 34 > binary.length || ![0, 1].includes(binary[slot]) || ![0, 1].includes(binary[slot + 1])) {
      throw new Error("Unsupported macOS ASAR integrity digest slot");
    }
    offsets.push(slot);
  }
  // 先验证所有架构的槽位，再修改；Universal 二进制中的每个架构都需要同步。
  const result = Buffer.from(binary);
  for (const slot of offsets) {
    result[slot] = 1;
    result[slot + 1] = 1;
    digest.copy(result, slot + 2);
  }
  return { binary: result, changed: !result.equals(binary), slots: offsets.length };
}

function updateFrameworkIntegrity(frameworksDir, headerHash, signFramework) {
  for (const entry of fs.readdirSync(frameworksDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".framework")) continue;
    const framework = path.join(frameworksDir, entry.name);
    const executable = path.join(framework, entry.name.slice(0, -".framework".length));
    if (!fs.existsSync(executable)) continue;
    // 拒绝越出 Runner 的链接，防止历史缓存或异常布局将写入导向官方安装包。
    const relative = path.relative(fs.realpathSync(frameworksDir), fs.realpathSync(executable));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("macOS framework executable resolves outside runner Frameworks");
    }
    const original = fs.readFileSync(executable);
    const patched = patchIntegrityDigest(original, headerHash);
    if (!patched.slots) continue; // 老版运行时没有摘要槽，继续使用 plist 校验。
    if (patched.changed) fs.writeFileSync(executable, patched.binary);
    // 缓存也重新签名，允许上次签名中断后安全重试，不留下已修改但签名失效的副本。
    signFramework(framework);
  }
}

module.exports = { patchIntegrityDigest, updateFrameworkIntegrity };
