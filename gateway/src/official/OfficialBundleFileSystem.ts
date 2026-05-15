// @ts-nocheck
export {};

const fs = require("fs");
const path = require("path");
const os = require("os");

/** 封装 provider 需要的文件系统操作，集中处理 home/env 展开、目录创建和原子替换所需操作。 */
class OfficialBundleFileSystem {
  constructor({
    env = process.env,
    homeDir = os.homedir(),
  }: {
    env?: Record<string, string | undefined>;
    homeDir?: string;
  } = {}) {
    this.env = env;
    this.homeDir = homeDir;
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

  rename(fromPath: string, toPath: string): void {
    fs.renameSync(fromPath, toPath);
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
