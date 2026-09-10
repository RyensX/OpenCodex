const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function chromiumAppId(url) {
  // Chromium 对 manifest id 做两次 SHA-256，再把十六进制映射到 a-p。
  const manifestId = new URL("/", url).href;
  const first = crypto.createHash("sha256").update(manifestId).digest();
  return crypto.createHash("sha256").update(first).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
}

function sameAppUrl(candidate, target) {
  try {
    const actual = new URL(candidate);
    const expected = new URL("/", target);
    return actual.origin === expected.origin && actual.pathname === "/"
      && !actual.username && !actual.password;
  } catch {
    return false;
  }
}

function macAppMatches(info, url) {
  if (info.CrAppModeShortcutID && info.CrAppModeShortcutURL) {
    return sameAppUrl(info.CrAppModeShortcutURL, url);
  }
  // Safari 网页应用将启动地址保存在 Manifest 中，不能仅凭应用名称判断。
  return String(info.CFBundleIdentifier || "").startsWith("com.apple.Safari.WebApp.")
    && sameAppUrl(info.Manifest?.start_url, url);
}

function shortcutMatches(args, url) {
  const ids = [...String(args).matchAll(/(?:^|\s)"?--app-id(?:=|\s+)"?([a-p]{32})(?="?(?:\s|$))/g)];
  return ids.length === 1 && ids[0][1] === chromiumAppId(url);
}

function discoveryRoots(platform, home, env, desktopPath) {
  if (platform === "darwin") return [path.join(home, "Applications"), "/Applications"];
  if (platform === "win32") {
    const win = path.win32;
    return [
      env.APPDATA && win.join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
      env.ProgramData && win.join(env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs"),
      desktopPath || win.join(home, "Desktop"),
      env.PUBLIC && win.join(env.PUBLIC, "Desktop"),
    ].filter(Boolean);
  }
  if (platform === "linux") {
    return [
      path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "applications"),
      ...(env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":")
        .filter((dir) => path.isAbsolute(dir)).map((dir) => path.join(dir, "applications")),
      desktopPath || path.join(home, "Desktop"),
    ];
  }
  return [];
}

async function* installedEntries(roots, platform) {
  // 仅遍历系统应用入口，不扫描浏览器历史；限制层级和数量，避免异常目录拖住按钮。
  let remaining = 4000;
  const seen = new Set();
  async function* visit(dir, depth) {
    if (depth > 4 || remaining <= 0 || seen.has(dir)) return;
    seen.add(dir);
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (--remaining < 0) return;
      const file = path.join(dir, entry.name);
      const suffix = platform === "darwin" ? ".app" : platform === "win32" ? ".lnk" : ".desktop";
      // 部分 Linux 软件包导出的是符号链接；只跟随应用入口，不递归链接目录。
      if (entry.isSymbolicLink() && entry.name.toLowerCase().endsWith(suffix)) {
        try {
          const stat = await fs.stat(file);
          if (platform === "darwin" ? stat.isDirectory() : stat.isFile()) yield file;
        } catch { /* 已卸载应用可能留下断开的链接。 */ }
      } else if (platform === "darwin" && entry.isDirectory() && entry.name.endsWith(".app")) yield file;
      else if (entry.isDirectory()) yield* visit(file, depth + 1);
      else if (platform !== "darwin" && entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) yield file;
    }
  }
  for (const root of new Set(roots)) yield* visit(root, 0);
}

async function readMacInfo(bundle) {
  const file = path.join(bundle, "Contents", "Info.plist");
  const raw = await fs.readFile(file);
  if (!raw.subarray(0, 8).equals(Buffer.from("bplist00"))
    && !raw.includes(Buffer.from("CrAppModeShortcutURL"))
    && !raw.includes(Buffer.from("com.apple.Safari.WebApp."))) return {};
  const { stdout } = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], {
    timeout: 1500, maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function desktopCommand(source, url) {
  const section = source.match(/^\[Desktop Entry\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
  if (!section) return null;
  const fields = Object.fromEntries(section.split(/\r?\n/).filter((line) => /^[A-Za-z]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  if (fields.Type !== "Application" || fields.Hidden === "true" || !shortcutMatches(fields.Exec, url)) return null;
  // 按 Desktop Entry 的双引号语法拆参数，全程不用 shell 执行快捷方式文本。
  const args = [];
  let token = "", quoted = false, started = false;
  const command = fields.Exec.replace(/\\s/g, " ").replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r").replace(/\\\\/g, "\\");
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === '"') { quoted = !quoted; started = true; }
    else if (char === "\\") {
      if (++index >= command.length) return null;
      token += command[index]; started = true;
    } else if (/\s/.test(char) && !quoted) {
      if (started) args.push(token);
      token = ""; started = false;
    } else { token += char; started = true; }
  }
  if (quoted) return null;
  if (started) args.push(token);
  const expanded = [];
  for (const arg of args) {
    if (/^%[fFuU]$/.test(arg)) continue;
    if (/%(?!%)/.test(arg.replace(/%%/g, ""))) return null;
    expanded.push(arg.replace(/%%/g, "%"));
  }
  if (!expanded.length) return null;
  return { executable: expanded[0], args: expanded.slice(1), cwd: fields.Path || undefined };
}

function launchCommand(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd, detached: true, stdio: "ignore", shell: false,
    });
    let timer;
    const finish = (error) => {
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    child.once("error", finish);
    child.once("exit", (code, signal) => finish(code === 0 ? null : new Error(`PWA process exited: ${code ?? signal}`)));
    child.once("spawn", () => {
      // 捕获浏览器刚启动就退出的错误；常驻浏览器无需等待进程结束。
      timer = setTimeout(() => finish(), 800);
      child.unref();
    });
  });
}

async function findInstalledPwas(url, options = {}) {
  const platform = options.platform || process.platform;
  const roots = options.roots || discoveryRoots(platform, os.homedir(), process.env, options.desktopPath);
  const result = [];
  if (!["darwin", "win32", "linux"].includes(platform)) return result;
  for await (const entry of installedEntries(roots, platform)) {
    try {
      if (platform === "darwin") {
        const info = await (options.readMacInfo || readMacInfo)(entry);
        if (macAppMatches(info, url)) result.push({ path: entry });
      } else if (platform === "win32") {
        const link = options.shell.readShortcutLink(entry);
        if (shortcutMatches(link.args, url)) {
          await fs.access(link.target);
          result.push({ path: entry });
        }
      } else {
        const command = desktopCommand(await fs.readFile(entry, "utf8"), url);
        if (command) result.push({ path: entry, command });
      }
    } catch {
      // 单个快捷方式损坏、应用已卸载或目录无权限，都继续检查其他入口。
    }
  }
  return result;
}

async function openPwaOrBrowser(url, options) {
  const log = options.log || (() => {});
  try {
    const candidates = await (options.findInstalledPwas || findInstalledPwas)(url, options);
    for (const candidate of candidates) {
      try {
        if (candidate.command) await (options.launchCommand || launchCommand)(candidate.command);
        else {
          const error = await options.shell.openPath(candidate.path);
          if (error) throw new Error(error);
        }
        log("opened installed PWA");
        return "pwa";
      } catch (error) { log(`PWA launch failed: ${error.message}`); }
    }
  } catch (error) { log(`PWA discovery failed: ${error.message}`); }
  await options.shell.openExternal(url);
  return "browser";
}

module.exports = { chromiumAppId, sameAppUrl, macAppMatches, shortcutMatches, discoveryRoots,
  desktopCommand, findInstalledPwas, openPwaOrBrowser };
