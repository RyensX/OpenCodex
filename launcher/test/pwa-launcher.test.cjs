const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromiumAppId, sameAppUrl, macAppMatches, shortcutMatches, discoveryRoots,
  desktopCommand, findInstalledPwas, openPwaOrBrowser } = require("../pwa-launcher.cjs");

const URL = "http://localhost:3737";
// 固定值取自真实安装的 Chrome PWA，避免只验证算法自身的一致性。
const ID = "giiehljooedkpkanijpbaaifmknimhme";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-pwa-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("Chromium manifest id matches a real installed application", () => {
  assert.equal(chromiumAppId(URL), ID);
  assert.notEqual(chromiumAppId("http://localhost:28026"), ID);
  assert.equal(shortcutMatches(`--profile-directory="Profile 1" --app-id=${ID}`, URL), true);
  assert.equal(shortcutMatches(`"--app-id=${ID}"`, URL), true);
  assert.equal(shortcutMatches(`--app-id=${ID}x`, URL), false);
  assert.equal(shortcutMatches(`--app-id=${ID} --app-id=${ID}`, URL), false);
});

test("URL matching excludes other ports, hosts, schemes and apps", () => {
  assert.equal(sameAppUrl(`${URL}/?source=install`, URL), true);
  for (const candidate of ["http://localhost:28026/", "http://127.0.0.1:3737/",
    "https://localhost:3737/", `${URL}/other/`, "not-a-url", "http://user@localhost:3737/"]) {
    assert.equal(sameAppUrl(candidate, URL), false, candidate);
  }
  assert.equal(macAppMatches({ CFBundleName: "OpenCodex" }, URL), false);
  assert.equal(macAppMatches({ CFBundleIdentifier: "com.apple.Safari.WebApp.example",
    Manifest: { start_url: `${URL}/` } }, URL), true);
});

test("desktop entry preserves browser profile and handles field codes without a shell", () => {
  const source = `[Desktop Entry]\nType=Application\nExec="/opt/Browser With Spaces/chrome" --profile-directory="Profile 2" --app-id=${ID} %U\nPath=/tmp\n[Desktop Action Other]\nExec=wrong\n`;
  assert.deepEqual(desktopCommand(source, URL), {
    executable: "/opt/Browser With Spaces/chrome",
    args: ["--profile-directory=Profile 2", `--app-id=${ID}`], cwd: "/tmp",
  });
  assert.equal(desktopCommand(source.replace("Type=Application", "Type=Link"), URL), null);
  assert.equal(desktopCommand(source.replace("Type=Application", "Type=Application\nHidden=true"), URL), null);
  assert.equal(desktopCommand(source.replace("%U", "%i"), URL), null);
  assert.equal(desktopCommand(source.replace("%U", '"unterminated'), URL), null);
  assert.equal(desktopCommand(source, "http://localhost:28026"), null);
});

test("platform roots cover start menu, redirected desktop and XDG directories", () => {
  assert.deepEqual(discoveryRoots("win32", "C:\\Users\\Test", {
    APPDATA: "C:\\Roaming", ProgramData: "C:\\ProgramData", PUBLIC: "C:\\Users\\Public",
  }, "D:\\Desktop"), [
    "C:\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs",
    "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "D:\\Desktop", "C:\\Users\\Public\\Desktop",
  ]);
  assert.deepEqual(discoveryRoots("linux", "/home/test", {
    XDG_DATA_HOME: "/custom", XDG_DATA_DIRS: "/system:/other",
  }), ["/custom/applications", "/system/applications", "/other/applications", "/home/test/Desktop"]);
  assert.deepEqual(discoveryRoots("freebsd", "/home/test", {}), []);
});

test("macOS discovery excludes launcher and other instances, and survives damaged bundles", async (t) => {
  const root = await fixture(t);
  for (const name of ["Broken", "Launcher", "Correct", "Other", "Safari"]) {
    await fs.mkdir(path.join(root, `${name}.app`));
  }
  const found = await findInstalledPwas(URL, { platform: "darwin", roots: [root], readMacInfo: async (file) => {
    const name = path.basename(file);
    if (name === "Broken.app") throw new Error("invalid plist");
    if (name === "Launcher.app") return { CFBundleName: "OpenCodex" };
    if (name === "Safari.app") return { CFBundleIdentifier: "com.apple.Safari.WebApp.test", Manifest: { start_url: `${URL}/` } };
    return { CrAppModeShortcutID: ID, CrAppModeShortcutURL: name === "Correct.app" ? URL : "http://localhost:28026" };
  } });
  assert.deepEqual(found.map((item) => path.basename(item.path)), ["Correct.app", "Safari.app"]);
});

test("Windows discovery uses shortcut arguments and excludes uninstalled browsers", async (t) => {
  const root = await fixture(t);
  const target = path.join(root, "browser.exe");
  await fs.writeFile(target, "");
  for (const name of ["Correct", "Other", "Broken", "Uninstalled"]) await fs.writeFile(path.join(root, `${name}.lnk`), "");
  const found = await findInstalledPwas(URL, { platform: "win32", roots: [root], shell: {
    readShortcutLink(file) {
      if (file.endsWith("Broken.lnk")) throw new Error("broken link");
      return { target: file.endsWith("Uninstalled.lnk") ? `${target}.missing` : target,
        args: `--app-id=${file.endsWith("Other.lnk") ? "a".repeat(32) : ID}` };
    },
  } });
  assert.deepEqual(found.map((item) => path.basename(item.path)), ["Correct.lnk"]);
});

test("Linux discovery reads installed desktop entries and tolerates missing roots", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "renamed.desktop"), `[Desktop Entry]\nType=Application\nExec=/usr/bin/google-chrome --app-id=${ID}\n`);
  await fs.writeFile(path.join(root, "other.desktop"), `[Desktop Entry]\nType=Application\nExec=/usr/bin/google-chrome --app-id=${"a".repeat(32)}\n`);
  const found = await findInstalledPwas(URL, { platform: "linux", roots: [`${root}/missing`, root] });
  assert.equal(found.length, 1);
  assert.equal(found[0].command.executable, "/usr/bin/google-chrome");
});

test("PWA success opens the installed entry without opening a browser", async () => {
  const opened = [];
  assert.equal(await openPwaOrBrowser(URL, {
    findInstalledPwas: async () => [{ path: "/installed.app" }],
    shell: { openPath: async (file) => { opened.push(file); return ""; }, openExternal: async () => assert.fail("unexpected browser") },
  }), "pwa");
  assert.deepEqual(opened, ["/installed.app"]);
});

test("failed candidate proceeds to the next PWA", async () => {
  let attempts = 0;
  assert.equal(await openPwaOrBrowser(URL, {
    findInstalledPwas: async () => [{ path: "broken" }, { path: "working" }],
    shell: { openPath: async () => ++attempts === 1 ? "launch failed" : "", openExternal: async () => assert.fail("unexpected browser") },
  }), "pwa");
  assert.equal(attempts, 2);
});

test("missing PWA, discovery errors and launch errors all fall back to the original URL", async () => {
  for (const findInstalledPwas of [async () => [], async () => { throw new Error("denied"); },
    async () => [{ path: "broken" }], async () => [{ command: { executable: "missing", args: [] } }]]) {
    const opened = [];
    const result = await openPwaOrBrowser(URL, { findInstalledPwas,
      launchCommand: async () => { throw new Error("ENOENT"); },
      shell: { openPath: async () => "not found", openExternal: async (url) => opened.push(url) },
    });
    assert.equal(result, "browser");
    assert.deepEqual(opened, [URL]);
  }
});

test("Linux command launch detects real spawn and early process failures", async () => {
  // 使用短命 Node 进程验证启动机制，不依赖测试机器安装浏览器。
  for (const command of [
    { executable: path.join(os.tmpdir(), "opencodex-no-such-browser", "browser"), args: [] },
    { executable: process.execPath, args: ["-e", "process.exit(1)"] },
  ]) {
    let fallback = 0;
    assert.equal(await openPwaOrBrowser(URL, {
      findInstalledPwas: async () => [{ command }],
      shell: { openExternal: async () => { fallback++; } },
    }), "browser");
    assert.equal(fallback, 1);
  }
});

test("Linux command launch accepts successful browser handoff", async () => {
  assert.equal(await openPwaOrBrowser(URL, {
    findInstalledPwas: async () => [{ command: { executable: process.execPath, args: ["-e", "process.exit(0)"] } }],
    shell: { openExternal: async () => assert.fail("unexpected browser") },
  }), "pwa");
});
