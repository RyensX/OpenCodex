// @ts-nocheck
export {};

const path = require("path");

const NATIVE_PET_LOG_MARKER = "Native pet material attachment completed";
const MAC_PUSH_LOG_MARKER = "Failed to register macOS push notifications";
const GATEWAY_RUNTIME_ENV = "OPENCODEX_GATEWAY_HIDDEN_RUNTIME";
const NATIVE_PET_FACTORY_PATTERN =
  /function ([A-Za-z_$][\w$]*)\(\{devAppPath:([A-Za-z_$][\w$]*),platform:([A-Za-z_$][\w$]*)=process\.platform\}=\{\}\)\{if\(\3!==`darwin`\)return null;/g;
const NATIVE_PET_PREWARM_PATTERN =
  /async prewarm\(([A-Za-z_$][\w$]*)\)\{if\(this\.window!=null\|\|this\.openingWindowPromise!=null\|\|this\.isAppQuitting\)return;/g;
const NATIVE_PET_RESTORE_MARKER = "electron-avatar-overlay-open";
const NATIVE_PET_RESTORE_PATTERN =
  /async restoreOpenState\(([A-Za-z_$][\w$]*)\)\{this\.globalState\.get\(`electron-avatar-overlay-open`\)===!0&&await this\.open\(\1\)\}/g;
const OPTIMIZED_NATIVE_PET_FACTORY_PATTERN =
  /function [A-Za-z_$][\w$]*\(\{devAppPath:[A-Za-z_$][\w$]*,platform:([A-Za-z_$][\w$]*)=process\.platform\}=\{\}\)\{if\(\1!==`darwin`\|\|process\.env\.OPENCODEX_GATEWAY_HIDDEN_RUNTIME===`1`\)return null;/g;
const OPTIMIZED_NATIVE_PET_PREWARM_PATTERN =
  /async prewarm\([A-Za-z_$][\w$]*\)\{if\(process\.env\.OPENCODEX_GATEWAY_HIDDEN_RUNTIME===`1`\|\|this\.window!=null\|\|this\.openingWindowPromise!=null\|\|this\.isAppQuitting\)return;/g;
const OPTIMIZED_NATIVE_PET_RESTORE_PATTERN =
  /async restoreOpenState\(([A-Za-z_$][\w$]*)\)\{process\.env\.OPENCODEX_GATEWAY_HIDDEN_RUNTIME!==`1`&&this\.globalState\.get\(`electron-avatar-overlay-open`\)===!0&&await this\.open\(\1\)\}/g;
const MAC_PUSH_REGISTRATION_PATTERN =
  /process\.platform!==`darwin`\|\|([A-Za-z_$][\w$]*)!==([A-Za-z_$][\w$]*)\.a\.Prod\|\|([A-Za-z_$][\w$]*)\(\{appServerClient:/g;
const OPTIMIZED_MAC_PUSH_REGISTRATION_PATTERN =
  /process\.platform!==`darwin`\|\|process\.env\.OPENCODEX_GATEWAY_HIDDEN_RUNTIME===`1`\|\|([A-Za-z_$][\w$]*)!==([A-Za-z_$][\w$]*)\.a\.Prod\|\|([A-Za-z_$][\w$]*)\(\{appServerClient:/g;

function matchCount(source: string, pattern: RegExp): number {
  // 所有模式都带全局标记；match 返回完整命中列表，不复用可变 lastIndex。
  return source.match(pattern)?.length || 0;
}

/**
 * 对抽取到网关私有缓存中的官方 main 做最小、可验证的运行时适配。
 * 官方安装目录始终保持只读；补丁也只有在隐藏网关进程显式设置环境标记时才生效。
 */
class OfficialRuntimeOptimizer {
  constructor({ fileSystem }: { fileSystem: any }) {
    this.fileSystem = fileSystem;
  }

  optimize(bundleDir: string): any {
    const buildDir = path.join(bundleDir, ".vite", "build");
    let markerFileCount = 0;
    let compositionReadyFileCount = 0;
    let macPushMarkerFileCount = 0;
    let macPushReadyFileCount = 0;
    let patchedFileCount = 0;
    let prewarmReadyFileCount = 0;
    const unsupportedFiles = [];

    for (const entry of this.fileSystem.readDir(buildDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      const filePath = path.join(buildDir, entry.name);
      const source = this.fileSystem.readText(filePath);
      const hasNativePet = source.includes(NATIVE_PET_LOG_MARKER);
      const hasMacPush = source.includes(MAC_PUSH_LOG_MARKER);
      if (!hasNativePet && !hasMacPush) continue;

      let optimized = source;
      const unsupportedParts = [];

      if (hasNativePet) {
        markerFileCount += 1;
        const markerCount = source.split(NATIVE_PET_LOG_MARKER).length - 1;
        const recognizedFactoryCount =
          matchCount(source, NATIVE_PET_FACTORY_PATTERN) +
          matchCount(source, OPTIMIZED_NATIVE_PET_FACTORY_PATTERN);
        const recognizedPrewarmCount =
          matchCount(source, NATIVE_PET_PREWARM_PATTERN) +
          matchCount(source, OPTIMIZED_NATIVE_PET_PREWARM_PATTERN);
        const restoreMarkerCount = source.split(NATIVE_PET_RESTORE_MARKER).length - 1;
        const recognizedRestoreCount =
          matchCount(source, NATIVE_PET_RESTORE_PATTERN) +
          matchCount(source, OPTIMIZED_NATIVE_PET_RESTORE_PATTERN);
        // 一个 chunk 可能同时打包多份 Native pet 实现；只识别其中一份时仍必须报告布局不完整。
        if (recognizedFactoryCount >= markerCount) compositionReadyFileCount += 1;
        else unsupportedParts.push("native-bridge");
        if (recognizedPrewarmCount >= markerCount && recognizedRestoreCount >= restoreMarkerCount) {
          prewarmReadyFileCount += 1;
        } else unsupportedParts.push("prewarm");
        optimized = this.patchNativePetRestore(
          this.patchNativePetPrewarm(this.patchNativePetFactory(optimized))
        );
      }

      if (hasMacPush) {
        macPushMarkerFileCount += 1;
        const markerCount = source.split(MAC_PUSH_LOG_MARKER).length - 1;
        const recognizedCount =
          matchCount(source, MAC_PUSH_REGISTRATION_PATTERN) +
          matchCount(source, OPTIMIZED_MAC_PUSH_REGISTRATION_PATTERN);
        if (recognizedCount >= markerCount) macPushReadyFileCount += 1;
        else unsupportedParts.push("mac-push");
        optimized = this.patchMacPushRegistration(optimized);
      }

      if (optimized !== source) {
        this.fileSystem.writeFile(filePath, optimized);
        patchedFileCount += 1;
      }
      // 官方升级后结构变化时保留可识别的安全补丁，并把缺失部分写入 manifest；不能阻断 gateway 启动。
      if (unsupportedParts.length > 0) unsupportedFiles.push(`${entry.name}:${unsupportedParts.join(",")}`);
    }

    return {
      // 同一官方版本可能把实现拆进多个含 marker 的 chunk；必须全部成功才可抑制兼容性告警。
      nativePetComposition:
        markerFileCount === 0
          ? "not-present"
          : compositionReadyFileCount === markerFileCount
            ? "gateway-css-fallback"
            : "unsupported-layout",
      nativePetPrewarm:
        markerFileCount === 0
          ? "not-present"
          : prewarmReadyFileCount === markerFileCount
            ? "gateway-lazy"
            : "unsupported-layout",
      macPushRegistration:
        macPushMarkerFileCount === 0
          ? "not-present"
          : macPushReadyFileCount === macPushMarkerFileCount
            ? "gateway-disabled"
            : "unsupported-layout",
      patchedFileCount,
      unsupportedFiles,
    };
  }

  private patchNativePetFactory(source: string): string {
    // 同一压缩 chunk 可能包含多份平台工厂，必须全部改写后才能把该文件标为成功。
    return source.replace(
      NATIVE_PET_FACTORY_PATTERN,
      (match, _factoryName, _devAppPathName, platformName) =>
        match.replace(
          `if(${platformName}!==\`darwin\`)return null;`,
          // 隐藏运行时没有可见原生宠物窗口，直接沿用官方 null bridge 对应的 CSS fallback。
          `if(${platformName}!==\`darwin\`||process.env.${GATEWAY_RUNTIME_ENV}===\`1\`)return null;`
        )
    );
  }

  private patchNativePetPrewarm(source: string): string {
    return source.replace(
      NATIVE_PET_PREWARM_PATTERN,
      (match) =>
        match.replace(
          "if(this.window!=null||this.openingWindowPromise!=null||this.isAppQuitting)return;",
          // 网关空闲启动不预热不可见的宠物 renderer；真正触发语音/宠物时仍走官方懒创建逻辑。
          `if(process.env.${GATEWAY_RUNTIME_ENV}===\`1\`||this.window!=null||this.openingWindowPromise!=null||this.isAppQuitting)return;`
        )
    );
  }

  private patchNativePetRestore(source: string): string {
    return source.replace(NATIVE_PET_RESTORE_PATTERN, (match) =>
      match.replace(
        "this.globalState.get(`electron-avatar-overlay-open`)===!0&&",
        // 隐藏 profile 可能继承上次“宠物已打开”的持久状态；启动阶段不得因此创建第二个不可见 renderer。
        `process.env.${GATEWAY_RUNTIME_ENV}!==\`1\`&&this.globalState.get(\`electron-avatar-overlay-open\`)===!0&&`
      )
    );
  }

  private patchMacPushRegistration(source: string): string {
    return source.replace(MAC_PUSH_REGISTRATION_PATTERN, (match) =>
      match.replace(
        "process.platform!==`darwin`||",
        // 隐藏 runner 没有官方签名 entitlement，注册必然失败；浏览器通知继续走已有 WS 通知桥。
        `process.platform!==\`darwin\`||process.env.${GATEWAY_RUNTIME_ENV}===\`1\`||`
      )
    );
  }
}

module.exports = {
  GATEWAY_RUNTIME_ENV,
  OfficialRuntimeOptimizer,
  __test: {
    NATIVE_PET_FACTORY_PATTERN,
    NATIVE_PET_LOG_MARKER,
    NATIVE_PET_PREWARM_PATTERN,
    NATIVE_PET_RESTORE_PATTERN,
    OPTIMIZED_NATIVE_PET_FACTORY_PATTERN,
    OPTIMIZED_NATIVE_PET_PREWARM_PATTERN,
    OPTIMIZED_NATIVE_PET_RESTORE_PATTERN,
    MAC_PUSH_LOG_MARKER,
    MAC_PUSH_REGISTRATION_PATTERN,
    OPTIMIZED_MAC_PUSH_REGISTRATION_PATTERN,
  },
};
