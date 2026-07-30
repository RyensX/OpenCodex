// @ts-nocheck
export {};

const fs = require("fs");
const path = require("path");
const os = require("os");

const WINDOWS_READ_WRITE_COPY_BUFFER_SIZE = 8 * 1024 * 1024;

/** 封装 provider 需要的文件系统操作，集中处理 home/env 展开、目录创建和原子替换所需操作。 */
class OfficialBundleFileSystem {
  constructor({
    env = process.env,
    homeDir = os.homedir(),
    platform = process.platform,
  }: {
    env?: Record<string, string | undefined>;
    homeDir?: string;
    platform?: NodeJS.Platform;
  } = {}) {
    this.env = env;
    this.homeDir = homeDir;
    this.platform = platform;
  }

  normalizePath(rawPath: string): string {
    return path.resolve(this.expandHome(this.expandEnvironmentVariables(rawPath)));
  }

  realpath(filePath: string): string {
    try {
      return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
    } catch {
      return path.resolve(filePath);
    }
  }

  isFile(filePath: string): boolean {
    try {
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  }

  isDirectory(filePath: string): boolean {
    try {
      return fs.statSync(filePath).isDirectory();
    } catch {
      return false;
    }
  }

  exists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  stat(filePath: string): any {
    return fs.statSync(filePath);
  }

  readText(filePath: string): string {
    return fs.readFileSync(filePath, "utf-8");
  }

  /** 只读取日志前缀，避免为兜底路径探测把大型日志整文件读进内存。 */
  readTextPrefix(filePath: string, maxBytes: number): string {
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(Math.max(0, maxBytes));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  }

  readDir(dirPath: string, options?: any): any[] {
    return fs.readdirSync(dirPath, options);
  }

  writeFile(filePath: string, data: Buffer | string): void {
    this.ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, data);
  }

  writeJson(filePath: string, value: unknown): void {
    this.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  ensureDir(dirPath: string): void {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  removeTree(dirPath: string): void {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }

  copyTree(fromPath: string, toPath: string): void {
    // 官方 app.asar.unpacked 里放的是 native addon 等 asar 不能承载的文件；复制到缓存工作副本时允许覆盖旧残留。
    this.ensureDir(path.dirname(toPath));
    try {
      fs.cpSync(fromPath, toPath, { recursive: true, force: true });
    } catch (error) {
      if (this.platform !== "win32") throw error;
      // 原生复制可能已写入部分内容；兜底时只覆盖来源文件，不能删除工作副本中的已有运行时。
      this.copyTreeByReadWrite(fromPath, toPath);
    }
  }

  rename(fromPath: string, toPath: string): void {
    fs.renameSync(fromPath, toPath);
  }

  private copyFileByReadWrite(fromPath: string, toPath: string): void {
    this.ensureDir(path.dirname(toPath));
    const buffer = Buffer.allocUnsafe(WINDOWS_READ_WRITE_COPY_BUFFER_SIZE);
    let sourceFd = null;
    let targetFd = null;

    try {
      sourceFd = fs.openSync(fromPath, "r");
      targetFd = fs.openSync(toPath, "w");

      for (;;) {
        const bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;

        let offset = 0;
        while (offset < bytesRead) {
          offset += fs.writeSync(targetFd, buffer, offset, bytesRead - offset);
        }
      }
    } finally {
      if (targetFd !== null) fs.closeSync(targetFd);
      if (sourceFd !== null) fs.closeSync(sourceFd);
    }

    try {
      const stat = fs.statSync(fromPath);
      fs.chmodSync(toPath, stat.mode);
      fs.utimesSync(toPath, stat.atime, stat.mtime);
    } catch {}
  }

  private copyTreeByReadWrite(fromPath: string, toPath: string): void {
    const stat = fs.statSync(fromPath);
    if (stat.isFile()) {
      this.copyFileByReadWrite(fromPath, toPath);
      return;
    }

    if (!stat.isDirectory()) {
      fs.cpSync(fromPath, toPath, { recursive: true, force: true, verbatimSymlinks: true });
      return;
    }

    this.ensureDir(toPath);
    for (const entry of fs.readdirSync(fromPath, { withFileTypes: true })) {
      const childFromPath = path.join(fromPath, entry.name);
      const childToPath = path.join(toPath, entry.name);
      if (entry.isDirectory()) {
        this.copyTreeByReadWrite(childFromPath, childToPath);
      } else if (entry.isFile()) {
        this.copyFileByReadWrite(childFromPath, childToPath);
      } else {
        fs.cpSync(childFromPath, childToPath, { recursive: true, force: true, verbatimSymlinks: true });
      }
    }
  }

  private expandHome(rawPath: string): string {
    if (rawPath === "~") return this.homeDir;
    if (rawPath.startsWith("~/")) return path.join(this.homeDir, rawPath.slice(2));
    return rawPath;
  }

  private expandEnvironmentVariables(rawPath: string): string {
    return rawPath
      .replace(/%([^%]+)%/g, (_match, name) => this.env[name] || this.env[String(name).toUpperCase()] || "")
      .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name) => this.env[name] || "");
  }
}

module.exports = { OfficialBundleFileSystem };
