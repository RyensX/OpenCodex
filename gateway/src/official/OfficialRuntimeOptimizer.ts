// @ts-nocheck
export {};

const path = require("path");

const NATIVE_PET_LOG_MARKER = "Native pet material attachment completed";
const MAC_PUSH_LOG_MARKER = "Failed to register macOS push notifications";
const GIT_ORIGINS_LOG_MARKER = "[git-origins] worker-complete";
const WORKTREE_SHELL_ENVIRONMENT_MARKER = '"worktree-shell-environment-config"';
const GATEWAY_RUNTIME_ENV = "OPENCODEX_GATEWAY_HIDDEN_RUNTIME";
const GIT_ORIGIN_CACHE_MARKER = "__opencodexGitOriginCache";
const GIT_LOCAL_PREFILTER_MARKER = "__opencodexGitStatCache";
const GIT_BACKGROUND_TIMEOUT_MARKER = "__opencodexBackgroundGitTimeout";
const GIT_BACKGROUND_CACHE_MARKER = "__opencodexSidebarGitCommandCache";
const GIT_REPOSITORY_PREFLIGHT_MARKER = "__opencodexGitRepositoryPreflight";
const GIT_SIDEBAR_PREFLIGHT_MARKER = "__opencodexSidebarGitPreflight";
const WORKTREE_SHELL_ENVIRONMENT_CACHE_MARKER = "__opencodexWorktreeShellEnvironmentCache";
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
const GIT_ORIGIN_RESOLVER_PATTERN =
  /async function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=await \3\.getStableMetadata\(\2,\4\);if\(\5==null\)return null;let ([A-Za-z_$][\w$]*)=\3\.getWorktreeRepositoryForRoot\(\5\.root,\4\),([A-Za-z_$][\w$]*)=await \3\.getRepoRepository\(\2,\4\);return \7==null\?null:\{dir:\2,root:\6\.root,originUrl:await \7\.getOriginUrl\(\),commonDir:\7\.getCommonDir\(\)\}\}/g;
const GIT_LOCAL_PREFILTER_PATTERN =
  /async function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{if\(!\4\.isAbsolute\(\2\)\|\|\4\.normalize\(\2\)!==\2\|\|\2\.endsWith\(\4\.sep\)&&\2!==\4\.parse\(\2\)\.root\)return!0;let ([A-Za-z_$][\w$]*)=\2;for\(;;\)\{try\{let ([A-Za-z_$][\w$]*)=await \3\.stat\(\5,\{bypassCache:!0,followSymlinks:!1\}\);if\(\6\.isSymbolicLink\(\)\|\|!\6\.isDirectory\(\)\)return!0\}catch(?:\(([A-Za-z_$][\w$]*)\))?\{return(?: process\.env\.OPENCODEX_GATEWAY_HIDDEN_RUNTIME===`1`&&\([^}]{1,300}\)\?!1:)?!0\}for\(let ([A-Za-z_$][\w$]*) of ([A-Za-z_$][\w$]*)\)try\{return await \3\.stat\(\4\.join\(\5,\8\),\{bypassCache:!0,followSymlinks:!1\}\),!0\}catch\(([A-Za-z_$][\w$]*)\)\{if\(!([A-Za-z_$][\w$]*)\(\10\)\)return!0\}let ([A-Za-z_$][\w$]*)=\4\.dirname\(\5\);if\(\12===\5\)return!1;\5=\12\}\}/g;
const GIT_BACKGROUND_TIMEOUT_PATTERN =
  /async function (?<functionName>[A-Za-z_$][\w$]*)\((?<cwdName>[A-Za-z_$][\w$]*),(?<argsName>[A-Za-z_$][\w$]*),(?<hostName>[A-Za-z_$][\w$]*),(?<optionsName>[A-Za-z_$][\w$]*)=\{\}\)\{let\{[^}]{0,1400}timeoutMs:(?<timeoutOptionName>[A-Za-z_$][\w$]*)[^}]{0,1400}\}=\k<optionsName>,[^;]{1,2400}?(?<timeoutName>[A-Za-z_$][\w$]*)=Object\.is\(\k<timeoutOptionName>,null\)\?void 0:\k<timeoutOptionName>\?\?\([^;]{1,400}?\),(?<idName>[A-Za-z_$][\w$]*)=crypto\.randomUUID\(\)\.slice\(0,8\),(?<startedName>[A-Za-z_$][\w$]*)=Date\.now\(\),(?<deadlineName>[A-Za-z_$][\w$]*)=\k<timeoutName>==null\?void 0:\k<startedName>\+\k<timeoutName>,(?<contextName>[A-Za-z_$][\w$]*)=(?<contextFactoryName>[A-Za-z_$][\w$]*)\(\),(?<metadataKeyName>[A-Za-z_$][\w$]*)=[^;]{1,1200}?\k<contextName>\.metadataCommonDir[^;]{1,1200}?;[\s\S]{0,18000}?let (?<timerName>[A-Za-z_$][\w$]*)=\k<timeoutName>==null\?null:setTimeout/g;
const WORKTREE_SHELL_ENVIRONMENT_PATTERN =
  /"worktree-shell-environment-config":(async\(\{cwd:([A-Za-z_$][\w$]*),hostId:([A-Za-z_$][\w$]*)\}\)=>\{let [^;]{1,1000};return\{shellEnvironment:[^{}]{1,300}\}\})/g;

function matchCount(source: string, pattern: RegExp): number {
  // 所有模式都带全局标记；match 返回完整命中列表，不复用可变 lastIndex。
  return source.match(pattern)?.length || 0;
}

/**
 * 对抽取到网关私有缓存中的官方 main 做最小、可验证的运行时适配。
 * 官方安装目录始终保持只读；补丁也只有在隐藏网关进程显式设置环境标记时才生效。
 */
class OfficialRuntimeOptimizer {
  constructor({ fileSystem, compatibilityService = null }: { fileSystem: any; compatibilityService?: any }) {
    this.fileSystem = fileSystem;
    this.compatibilityService = compatibilityService;
  }

  optimize(bundleDir: string): any {
    const buildDir = path.join(bundleDir, ".vite", "build");
    let markerFileCount = 0;
    let compositionReadyFileCount = 0;
    let macPushMarkerFileCount = 0;
    let macPushReadyFileCount = 0;
    let gitDiscoveryMarkerFileCount = 0;
    let gitDiscoveryReadyFileCount = 0;
    let worktreeShellEnvironmentMarkerFileCount = 0;
    let worktreeShellEnvironmentReadyFileCount = 0;
    let patchedFileCount = 0;
    let prewarmReadyFileCount = 0;
    let nativePetRestoreMarkerCount = 0;
    const unsupportedFiles = [];

    for (const entry of this.fileSystem.readDir(buildDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      const filePath = path.join(buildDir, entry.name);
      const source = this.fileSystem.readText(filePath);
      const hasNativePet = source.includes(NATIVE_PET_LOG_MARKER);
      const hasMacPush = source.includes(MAC_PUSH_LOG_MARKER);
      const hasGitDiscovery = source.includes(GIT_ORIGINS_LOG_MARKER);
      const hasWorktreeShellEnvironment = source.includes(WORKTREE_SHELL_ENVIRONMENT_MARKER);
      if (!hasNativePet && !hasMacPush && !hasGitDiscovery && !hasWorktreeShellEnvironment) continue;

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
        nativePetRestoreMarkerCount += restoreMarkerCount;
        const recognizedRestoreCount =
          matchCount(source, NATIVE_PET_RESTORE_PATTERN) +
          matchCount(source, OPTIMIZED_NATIVE_PET_RESTORE_PATTERN);
        // 一个 chunk 可能同时打包多份 Native pet 实现；只识别其中一份时仍必须报告布局不完整。
        const factorySupported = recognizedFactoryCount >= markerCount;
        const prewarmSupported = recognizedPrewarmCount >= markerCount;
        const restoreSupported = recognizedRestoreCount >= restoreMarkerCount;
        if (factorySupported) compositionReadyFileCount += 1;
        else unsupportedParts.push("native-bridge");
        if (prewarmSupported && restoreSupported) {
          prewarmReadyFileCount += 1;
        } else unsupportedParts.push("prewarm");
        optimized = this.runPatchPoint({
          id: "static.cache.main.native-pet.factory",
          source: optimized,
          fileName: entry.name,
          candidateCount: recognizedFactoryCount,
          expectedCandidates: markerCount,
          supported: factorySupported,
          patcher: (value) => this.patchNativePetFactory(value),
        });
        optimized = this.runPatchPoint({
          id: "static.cache.main.native-pet.prewarm",
          source: optimized,
          fileName: entry.name,
          candidateCount: recognizedPrewarmCount,
          expectedCandidates: markerCount,
          supported: prewarmSupported,
          patcher: (value) => this.patchNativePetPrewarm(value),
        });
        if (restoreMarkerCount > 0) {
          optimized = this.runPatchPoint({
            id: "static.cache.main.native-pet.restore",
            source: optimized,
            fileName: entry.name,
            candidateCount: recognizedRestoreCount,
            expectedCandidates: restoreMarkerCount,
            supported: restoreSupported,
            patcher: (value) => this.patchNativePetRestore(value),
          });
        }
      }

      if (hasMacPush) {
        macPushMarkerFileCount += 1;
        const markerCount = source.split(MAC_PUSH_LOG_MARKER).length - 1;
        const recognizedCount =
          matchCount(source, MAC_PUSH_REGISTRATION_PATTERN) +
          matchCount(source, OPTIMIZED_MAC_PUSH_REGISTRATION_PATTERN);
        const supported = recognizedCount >= markerCount;
        if (supported) macPushReadyFileCount += 1;
        else unsupportedParts.push("mac-push");
        optimized = this.runPatchPoint({
          id: "static.cache.main.macos-push-registration",
          source: optimized,
          fileName: entry.name,
          candidateCount: recognizedCount,
          expectedCandidates: markerCount,
          supported,
          patcher: (value) => this.patchMacPushRegistration(value),
        });
      }

      if (hasGitDiscovery) {
        gitDiscoveryMarkerFileCount += 1;
        const markerCount = source.split(GIT_ORIGINS_LOG_MARKER).length - 1;
        const recognizedOriginCount =
          matchCount(source, GIT_ORIGIN_RESOLVER_PATTERN) +
          (source.includes(GIT_ORIGIN_CACHE_MARKER) ? markerCount : 0);
        const recognizedLocalPrefilterCount =
          matchCount(source, GIT_LOCAL_PREFILTER_PATTERN) +
          (source.includes(GIT_LOCAL_PREFILTER_MARKER) &&
          source.includes(GIT_REPOSITORY_PREFLIGHT_MARKER)
            ? markerCount
            : 0);
        const recognizedBackgroundTimeoutCount =
          matchCount(source, GIT_BACKGROUND_TIMEOUT_PATTERN) +
          (source.includes(GIT_BACKGROUND_TIMEOUT_MARKER) &&
          source.includes(GIT_SIDEBAR_PREFLIGHT_MARKER) &&
          source.includes(GIT_BACKGROUND_CACHE_MARKER)
            ? markerCount
            : 0);
        const originSupported = recognizedOriginCount >= markerCount;
        const prefilterSupported = recognizedLocalPrefilterCount >= markerCount;
        const backgroundSupported = recognizedBackgroundTimeoutCount >= markerCount;
        if (originSupported && prefilterSupported && backgroundSupported) {
          gitDiscoveryReadyFileCount += 1;
        } else {
          unsupportedParts.push("git-discovery");
        }
        // 只合并完全相同的 origin 探测；隐藏网关的侧栏后台任务使用保护时限，用户主动与远端 Git 操作仍保留官方超时。
        optimized = this.runPatchPoint({
          id: "static.cache.main.git-background-command",
          source: optimized,
          fileName: entry.name,
          candidateCount: recognizedBackgroundTimeoutCount,
          expectedCandidates: markerCount,
          supported: backgroundSupported,
          patcher: (value) => this.patchGitBackgroundTimeout(value),
        });
        optimized = this.runPatchPoint({
          id: "static.cache.main.git-local-prefilter",
          source: optimized,
          fileName: entry.name,
          candidateCount: recognizedLocalPrefilterCount,
          expectedCandidates: markerCount,
          supported: prefilterSupported,
          patcher: (value) => this.patchGitLocalPrefilter(value),
        });
        optimized = this.runPatchPoint({
          id: "static.cache.main.git-origin-resolver",
          source: optimized,
          fileName: entry.name,
          candidateCount: recognizedOriginCount,
          expectedCandidates: markerCount,
          supported: originSupported,
          patcher: (value) => this.patchGitOriginResolver(value),
        });
      }

      if (hasWorktreeShellEnvironment) {
        worktreeShellEnvironmentMarkerFileCount += 1;
        const markerCount = source.split(WORKTREE_SHELL_ENVIRONMENT_MARKER).length - 1;
        const recognizedCount =
          matchCount(source, WORKTREE_SHELL_ENVIRONMENT_PATTERN) +
          (source.includes(WORKTREE_SHELL_ENVIRONMENT_CACHE_MARKER) ? markerCount : 0);
        const supported = recognizedCount >= markerCount;
        if (supported) worktreeShellEnvironmentReadyFileCount += 1;
        else unsupportedParts.push("worktree-shell-environment");
        optimized = this.runPatchPoint({
          id: "static.cache.main.worktree-shell-environment",
          source: optimized,
          fileName: entry.name,
          candidateCount: recognizedCount,
          expectedCandidates: markerCount,
          supported,
          patcher: (value) => this.patchWorktreeShellEnvironment(value),
        });
      }

      if (optimized !== source) {
        this.fileSystem.writeFile(filePath, optimized);
        patchedFileCount += 1;
      }
      // 官方升级后结构变化时保留可识别的安全补丁，并把缺失部分写入 manifest；不能阻断 gateway 启动。
      if (unsupportedParts.length > 0) unsupportedFiles.push(`${entry.name}:${unsupportedParts.join(",")}`);
    }

    const result: any = {
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
    if (gitDiscoveryMarkerFileCount > 0) {
      // 该字段只在含 Git discovery 的官方版本中写入，旧版 manifest 结构保持兼容。
      result.gitDiscovery =
        gitDiscoveryReadyFileCount === gitDiscoveryMarkerFileCount
          ? "gateway-coalesced"
          : "unsupported-layout";
    }
    if (worktreeShellEnvironmentMarkerFileCount > 0) {
      // 只在官方版本暴露该接口时记录能力，旧版 manifest 不增加无意义字段。
      result.worktreeShellEnvironment =
        worktreeShellEnvironmentReadyFileCount === worktreeShellEnvironmentMarkerFileCount
          ? "gateway-coalesced"
          : "unsupported-layout";
    }
    this.reportAbsentPoint("static.cache.main.native-pet.factory", markerFileCount);
    this.reportAbsentPoint("static.cache.main.native-pet.prewarm", markerFileCount);
    this.reportAbsentPoint("static.cache.main.native-pet.restore", nativePetRestoreMarkerCount);
    this.reportAbsentPoint("static.cache.main.macos-push-registration", macPushMarkerFileCount);
    this.reportAbsentPoint("static.cache.main.git-origin-resolver", gitDiscoveryMarkerFileCount);
    this.reportAbsentPoint("static.cache.main.git-local-prefilter", gitDiscoveryMarkerFileCount);
    this.reportAbsentPoint("static.cache.main.git-background-command", gitDiscoveryMarkerFileCount);
    this.reportAbsentPoint("static.cache.main.worktree-shell-environment", worktreeShellEnvironmentMarkerFileCount);
    return result;
  }

  private runPatchPoint({
    id,
    source,
    fileName,
    candidateCount,
    expectedCandidates,
    supported,
    patcher,
  }: {
    id: string;
    source: string;
    fileName: string;
    candidateCount: number;
    expectedCandidates: number;
    supported: boolean;
    patcher: (source: string) => string;
  }): string {
    // 兼容骨架只增加状态和受控入口；布局部分变化时继续沿用旧版“安全命中部分仍应用”的行为。
    if (!supported || expectedCandidates < 1) {
      if (this.compatibilityService) {
        try {
          const method = candidateCount > expectedCandidates ? "ambiguousPoint" : "unsupportedPoint";
          this.compatibilityService[method](id, {
            locatorRevision: "official-main-v1",
            strategyId: "static-regex",
            candidateCount,
            expectedCandidates: Math.max(1, expectedCandidates),
            reason: `Expected ${expectedCandidates} candidates but found ${candidateCount}`,
          });
        } catch {}
      }
      return patcher(source);
    }
    if (!this.compatibilityService) return patcher(source);
    try {
      const capability = this.compatibilityService.bindCapability(id, patcher, {
        locatorRevision: "official-main-v1",
        strategyId: "static-regex",
        candidateCount,
        expectedCandidates,
        targetKey: fileName,
        fallback: patcher,
        verify: () => typeof patcher === "function",
      });
      return capability(source);
    } catch {
      // 诊断骨架失败时直接执行原 patch，不能改变缓存生成结果或阻断 Gateway 启动。
      return patcher(source);
    }
  }

  private reportAbsentPoint(id: string, markerFileCount: number): void {
    if (!this.compatibilityService || markerFileCount > 0) return;
    try {
      this.compatibilityService.unsupportedPoint(id, {
        locatorRevision: "official-main-v1",
        strategyId: "static-regex",
        reason: "Official capability marker is not present",
      });
    } catch {}
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

  private patchGitBackgroundTimeout(source: string): string {
    if (
      source.includes(GIT_BACKGROUND_TIMEOUT_MARKER) &&
      source.includes(GIT_SIDEBAR_PREFLIGHT_MARKER) &&
      source.includes(GIT_BACKGROUND_CACHE_MARKER)
    ) {
      return source;
    }
    return source.replace(GIT_BACKGROUND_TIMEOUT_PATTERN, (match, ...replaceArgs) => {
      const groups = replaceArgs.at(-1);
      if (!groups || typeof groups !== "object") return match;
      const {
        argsName,
        contextName,
        contextFactoryName,
        cwdName,
        deadlineName,
        functionName,
        hostName,
        metadataKeyName,
        optionsName,
        startedName,
        timeoutName,
        timeoutOptionName,
        timerName,
      } = groups;
      const timerStart = `let ${timerName}=${timeoutName}==null?null:setTimeout`;
      if (!match.includes(timerStart)) return match;
      const metadataStart = match.indexOf(`,${metadataKeyName}=`);
      const metadataEnd = metadataStart < 0 ? -1 : match.indexOf(";", metadataStart);
      if (metadataEnd < 0) return match;
      /**
       * 只缩短隐藏网关的本地侧栏元数据任务；显式 timeout、远端 host、会话内 Git 命令
       * 与原生桌面运行时仍保留官方时限。正常本地仓库实测只需几十毫秒，隐藏侧栏用一秒
       * 上限即可兼容常规磁盘抖动，同时避免云盘占位目录把首屏阻塞五秒。保护必须放在
       * readiness、锁与 spawn 之前，否则这些前置步骤卡住时仍会沿用官方 60 秒 deadline。
       */
      const backgroundCondition =
        `process.env.${GATEWAY_RUNTIME_ENV}===\`1\`&&${hostName}.isLocal&&${timeoutOptionName}===void 0&&` +
        `(${contextName}.requestKind===\`git-origins\`||${contextName}.requestKind===\`stable-metadata\`&&${contextName}.source===\`sidebar_task_pr_chip\`)`;
      const guard =
        `${backgroundCondition}&&(${timeoutName}=1e3,${deadlineName}=${startedName}+${timeoutName});` +
        `/*${GIT_BACKGROUND_TIMEOUT_MARKER}*/` +
        /**
         * 侧栏 stable-metadata 可能直接绕过 git-origins 的目录筛选。先用带软超时的
         * stat 向上查找仓库标记；确认不是仓库时返回 Git 标准的 code 128 结果，
         * 让官方 metadata 逻辑自然得到 null，且完全不创建 Git 子进程。
         */
        `if(${backgroundCondition}&&typeof __opencodexGitHasRepositoryMarker===\`function\`&&!await __opencodexGitHasRepositoryMarker(${hostName},${cwdName})){let __opencodexMessage=\`fatal: not a git repository\`;return{command:\`git\`,success:!1,code:128,stdout:\`\`,stdoutBytes:0,stderr:__opencodexMessage,stderrBytes:__opencodexMessage.length}}` +
        `/*${GIT_SIDEBAR_PREFLIGHT_MARKER}*/`;
      const patched = `${match.slice(0, metadataEnd + 1)}${guard}${match.slice(metadataEnd + 1)}`;
      const originalHeader =
        `async function ${functionName}(${cwdName},${argsName},${hostName},${optionsName}={}){`;
      if (!patched.startsWith(originalHeader)) return match;
      const uncachedName = `__opencodexUncached_${functionName}`;
      /**
       * 多个侧栏消费者会并发请求完全相同的 rev-parse。按 host、目录和参数跨调用场景复用
       * 在途 Promise；普通结果只缓存五秒。失败过期后先返回旧值、后台单次刷新，并对连续失败
       * 指数退避到最多三十分钟：页面不再等待云盘占位仓库，仓库恢复后仍能自动刷新。
       * 包装器仍调用上方同一保护函数，因此前台、远端和显式 timeout 完全绕过缓存。
       */
      const wrapper = [
        `var ${GIT_BACKGROUND_CACHE_MARKER}=new Map;`,
        `async function ${functionName}(${cwdName},${argsName},${hostName},${optionsName}={}){`,
        `let __opencodexContext=${contextFactoryName}(),__opencodexBackground=process.env.${GATEWAY_RUNTIME_ENV}===\`1\`&&${hostName}.isLocal&&${optionsName}.timeoutMs===void 0&&(__opencodexContext.requestKind===\`git-origins\`||__opencodexContext.requestKind===\`stable-metadata\`&&__opencodexContext.source===\`sidebar_task_pr_chip\`);`,
        `if(!__opencodexBackground)return ${uncachedName}(${cwdName},${argsName},${hostName},${optionsName});`,
        `let __opencodexKey=JSON.stringify([${hostName}.id,${cwdName},${argsName}]),__opencodexNow=Date.now(),__opencodexCached=${GIT_BACKGROUND_CACHE_MARKER}.get(__opencodexKey);`,
        `if(__opencodexCached!=null&&(__opencodexCached.pending||__opencodexCached.expiresAt>__opencodexNow))return __opencodexCached.promise;`,
        `let __opencodexStale=__opencodexCached?.failure??null,__opencodexFailureCount=__opencodexCached?.failureCount??0;`,
        `for(let[__opencodexOldKey,__opencodexOld]of ${GIT_BACKGROUND_CACHE_MARKER})if(!__opencodexOld.pending&&__opencodexOld.failure==null&&__opencodexOld.expiresAt<=__opencodexNow)${GIT_BACKGROUND_CACHE_MARKER}.delete(__opencodexOldKey);`,
        `if(${GIT_BACKGROUND_CACHE_MARKER}.size>=512){for(let[__opencodexOldKey,__opencodexOld]of ${GIT_BACKGROUND_CACHE_MARKER}){if(!__opencodexOld.pending)${GIT_BACKGROUND_CACHE_MARKER}.delete(__opencodexOldKey);if(${GIT_BACKGROUND_CACHE_MARKER}.size<512)break}if(${GIT_BACKGROUND_CACHE_MARKER}.size>=512){let __opencodexMessage=\`fatal: not a git repository\`;return{command:\`git\`,success:!1,code:128,stdout:\`\`,stdoutBytes:0,stderr:__opencodexMessage,stderrBytes:__opencodexMessage.length}}}`,
        `let __opencodexRaw=${uncachedName}(${cwdName},${argsName},${hostName},${optionsName}),__opencodexEntry={expiresAt:0,failure:__opencodexStale,failureCount:__opencodexFailureCount,pending:!0,promise:__opencodexStale==null?__opencodexRaw:Promise.resolve(__opencodexStale)};`,
        `${GIT_BACKGROUND_CACHE_MARKER}.set(__opencodexKey,__opencodexEntry),__opencodexRaw.then(__opencodexValue=>{__opencodexEntry.pending=!1;if(__opencodexValue?.success===!1){__opencodexEntry.failure=__opencodexValue,__opencodexEntry.failureCount+=1,__opencodexEntry.expiresAt=Date.now()+Math.min(18e5,6e4*2**Math.min(__opencodexEntry.failureCount-1,5))}else{__opencodexEntry.failure=null,__opencodexEntry.failureCount=0,__opencodexEntry.expiresAt=Date.now()+5e3}__opencodexEntry.promise=Promise.resolve(__opencodexValue)},__opencodexError=>{__opencodexEntry.pending=!1,__opencodexEntry.failureCount+=1,__opencodexEntry.expiresAt=Date.now()+Math.min(18e5,6e4*2**Math.min(__opencodexEntry.failureCount-1,5));if(__opencodexStale!=null)__opencodexEntry.failure=__opencodexStale,__opencodexEntry.promise=Promise.resolve(__opencodexStale)});`,
        `return __opencodexEntry.promise}`,
      ].join("");
      return `${wrapper}${patched.replace(originalHeader, `async function ${uncachedName}(${cwdName},${argsName},${hostName},${optionsName}={}){`)}`;
    });
  }

  private patchGitOriginResolver(source: string): string {
    if (source.includes(GIT_ORIGIN_CACHE_MARKER)) return source;
    return source.replace(
      GIT_ORIGIN_RESOLVER_PATTERN,
      (match, functionName, dirName, managerName, hostName) => {
        const uncachedName = `__opencodexUncached_${functionName}`;
        const uncached = match.replace(
          `async function ${functionName}(`,
          `async function ${uncachedName}(`
        );
        /**
         * 不同浏览器标签会用不同目录子集同时询问 origin。按 host + 目录复用在途 Promise，
         * 五秒缓存与官方 renderer 的 staleTime 一致；全局并发闸门只约束隐藏运行时的后台 Git 子进程，
         * 不缩短官方超时；缓存全被在途任务占用时临时返回无 origin，避免过载请求继续堆积。
         */
        return [
          `var ${GIT_ORIGIN_CACHE_MARKER}=new Map,__opencodexGitOriginActive=0,__opencodexGitOriginQueue=[];`,
          `function __opencodexGitOriginRun(__opencodexTask){return new Promise((__opencodexResolve,__opencodexReject)=>{let __opencodexStart=()=>{__opencodexGitOriginActive+=1,Promise.resolve().then(__opencodexTask).then(__opencodexResolve,__opencodexReject).finally(()=>{__opencodexGitOriginActive-=1;let __opencodexNext=__opencodexGitOriginQueue.shift();__opencodexNext&&__opencodexNext()})};__opencodexGitOriginActive<4?__opencodexStart():__opencodexGitOriginQueue.push(__opencodexStart)})}`,
          uncached,
          `async function ${functionName}(${dirName},${managerName},${hostName}){`,
          `if(process.env.${GATEWAY_RUNTIME_ENV}!==\`1\`)return ${uncachedName}(${dirName},${managerName},${hostName});`,
          `let __opencodexKey=JSON.stringify([${hostName}.id,${dirName}]),__opencodexNow=Date.now(),__opencodexCached=${GIT_ORIGIN_CACHE_MARKER}.get(__opencodexKey);`,
          `if(__opencodexCached!=null&&(__opencodexCached.pending||__opencodexCached.expiresAt>__opencodexNow))return __opencodexCached.promise;`,
          `for(let[__opencodexOldKey,__opencodexOld]of ${GIT_ORIGIN_CACHE_MARKER})if(!__opencodexOld.pending&&__opencodexOld.expiresAt<=__opencodexNow)${GIT_ORIGIN_CACHE_MARKER}.delete(__opencodexOldKey);`,
          `if(${GIT_ORIGIN_CACHE_MARKER}.size>=256){for(let[__opencodexOldKey,__opencodexOld]of ${GIT_ORIGIN_CACHE_MARKER}){if(!__opencodexOld.pending)${GIT_ORIGIN_CACHE_MARKER}.delete(__opencodexOldKey);if(${GIT_ORIGIN_CACHE_MARKER}.size<256)break}if(${GIT_ORIGIN_CACHE_MARKER}.size>=256)return null}`,
          `let __opencodexPromise=__opencodexGitOriginRun(()=>${uncachedName}(${dirName},${managerName},${hostName})),__opencodexEntry={expiresAt:0,pending:!0,promise:__opencodexPromise};`,
          `${GIT_ORIGIN_CACHE_MARKER}.set(__opencodexKey,__opencodexEntry),__opencodexPromise.then(()=>{__opencodexEntry.pending=!1,__opencodexEntry.expiresAt=Date.now()+5e3},__opencodexError=>{__opencodexEntry.pending=!1,__opencodexEntry.expiresAt=Date.now()+(/timed out|Unable to read current working directory|Interrupted system call/i.test(__opencodexError?.message||\`\`)?6e4:5e3)});`,
          `return __opencodexPromise}`,
        ].join("");
      }
    );
  }

  private patchGitLocalPrefilter(source: string): string {
    if (source.includes(GIT_LOCAL_PREFILTER_MARKER)) return source;
    return source.replace(
      GIT_LOCAL_PREFILTER_PATTERN,
      (
        match,
        _functionName,
        _dirName,
        hostName,
        _pathName,
        _currentName,
        _statName,
        _outerErrorName,
        _markerName,
        markersName,
        innerErrorName,
        missingCheckName
      ) => {
        /**
         * macOS 云盘或失效挂载可能让 stat 长时间不返回。隐藏网关按 host + path 复用探测，
         * 并在软超时后短期退避；原始桌面运行时仍直接执行官方 stat，不改变官方行为。
         */
        const helper = [
          `var ${GIT_LOCAL_PREFILTER_MARKER}=new Map;`,
          `function __opencodexGitUnavailable(__opencodexMessage){let __opencodexError=Error(__opencodexMessage);return __opencodexError.code=\`ENOENT\`,__opencodexError.__opencodexSlow=!0,__opencodexError}`,
          `function __opencodexGitStat(__opencodexHost,__opencodexPath,__opencodexOptions){`,
          `if(process.env.${GATEWAY_RUNTIME_ENV}!==\`1\`)return __opencodexHost.stat(__opencodexPath,__opencodexOptions);`,
          `let __opencodexKey=JSON.stringify([__opencodexHost.id,__opencodexPath]),__opencodexNow=Date.now(),__opencodexCached=${GIT_LOCAL_PREFILTER_MARKER}.get(__opencodexKey);`,
          `if(__opencodexCached!=null&&(__opencodexCached.pending||__opencodexCached.expiresAt>__opencodexNow))return __opencodexCached.promise;`,
          `for(let[__opencodexOldKey,__opencodexOld]of ${GIT_LOCAL_PREFILTER_MARKER})if(!__opencodexOld.pending&&__opencodexOld.expiresAt<=__opencodexNow)${GIT_LOCAL_PREFILTER_MARKER}.delete(__opencodexOldKey);`,
          `if(${GIT_LOCAL_PREFILTER_MARKER}.size>=256){for(let[__opencodexOldKey,__opencodexOld]of ${GIT_LOCAL_PREFILTER_MARKER}){if(!__opencodexOld.pending)${GIT_LOCAL_PREFILTER_MARKER}.delete(__opencodexOldKey);if(${GIT_LOCAL_PREFILTER_MARKER}.size<256)break}if(${GIT_LOCAL_PREFILTER_MARKER}.size>=256)return Promise.reject(__opencodexGitUnavailable(\`OpenCodex Git stat cache is busy\`))}`,
          `let __opencodexTimer,__opencodexRaw=Promise.resolve().then(()=>__opencodexHost.stat(__opencodexPath,__opencodexOptions)),__opencodexTimeout=new Promise((__opencodexResolve,__opencodexReject)=>{__opencodexTimer=setTimeout(()=>__opencodexReject(__opencodexGitUnavailable(\`OpenCodex Git stat timed out\`)),1500),__opencodexTimer.unref?.()}),__opencodexPromise=Promise.race([__opencodexRaw,__opencodexTimeout]).catch(__opencodexError=>{if(__opencodexError?.__opencodexSlow||[\`EINTR\`,\`EIO\`,\`ESTALE\`,\`ETIMEDOUT\`].includes(__opencodexError?.code))throw __opencodexGitUnavailable(__opencodexError?.message||\`OpenCodex Git stat unavailable\`);throw __opencodexError}).finally(()=>clearTimeout(__opencodexTimer)),__opencodexEntry={expiresAt:0,pending:!0,promise:__opencodexPromise};`,
          `${GIT_LOCAL_PREFILTER_MARKER}.set(__opencodexKey,__opencodexEntry),__opencodexPromise.then(()=>{__opencodexEntry.pending=!1,__opencodexEntry.expiresAt=Date.now()+5e3},__opencodexError=>{__opencodexEntry.pending=!1,__opencodexEntry.expiresAt=Date.now()+(__opencodexError?.__opencodexSlow?6e4:5e3)});`,
          `return __opencodexPromise}`,
          `/*${GIT_REPOSITORY_PREFLIGHT_MARKER}*/`,
          `var __opencodexGitPathApi=require(\`path\`);`,
          `async function __opencodexGitHasRepositoryMarker(__opencodexHost,__opencodexDir){`,
          `if(process.env.${GATEWAY_RUNTIME_ENV}!==\`1\`||!__opencodexHost?.isLocal)return!0;`,
          `let __opencodexPath=__opencodexGitPathApi;if(!__opencodexPath.isAbsolute(__opencodexDir)||__opencodexPath.normalize(__opencodexDir)!==__opencodexDir||__opencodexDir.endsWith(__opencodexPath.sep)&&__opencodexDir!==__opencodexPath.parse(__opencodexDir).root)return!0;`,
          `let __opencodexCurrent=__opencodexDir;for(;;){try{let __opencodexStat=await __opencodexGitStat(__opencodexHost,__opencodexCurrent,{bypassCache:!0,followSymlinks:!1});if(__opencodexStat.isSymbolicLink()||!__opencodexStat.isDirectory())return!0}catch(__opencodexError){return __opencodexError?.code===\`ENOENT\`||__opencodexError?.code===\`ENOTDIR\`||__opencodexError?.__opencodexSlow?!1:!0}`,
          `for(let __opencodexMarker of ${markersName})try{await __opencodexGitStat(__opencodexHost,__opencodexPath.join(__opencodexCurrent,__opencodexMarker),{bypassCache:!0,followSymlinks:!1});return!0}catch(__opencodexError){if(__opencodexError?.__opencodexSlow)return!1;if(!${missingCheckName}(__opencodexError))return!0}`,
          `let __opencodexParent=__opencodexPath.dirname(__opencodexCurrent);if(__opencodexParent===__opencodexCurrent)return!1;__opencodexCurrent=__opencodexParent}}`,
        ].join("");
        const patched = match
          .replaceAll(`${hostName}.stat(`, `__opencodexGitStat(${hostName},`)
          .replace(
            /\}catch(?:\([A-Za-z_$][\w$]*\))?\{return[^}]{1,400}\}/,
            // 已删除或暂时不可读的目录不会产生 origin；退避结束后仍会按官方路径重新探测。
            `}catch(__opencodexStatError){return process.env.${GATEWAY_RUNTIME_ENV}===\`1\`&&(__opencodexStatError?.code===\`ENOENT\`||__opencodexStatError?.code===\`ENOTDIR\`||__opencodexStatError?.__opencodexSlow)?!1:!0}`
          )
          .replace(
            `catch(${innerErrorName}){if(!${missingCheckName}(${innerErrorName}))return!0}`,
            `catch(${innerErrorName}){if(process.env.${GATEWAY_RUNTIME_ENV}===\`1\`&&${innerErrorName}?.__opencodexSlow)return!1;if(!${missingCheckName}(${innerErrorName}))return!0}`
          );
        return `${helper}${patched}`;
      }
    );
  }

  private patchWorktreeShellEnvironment(source: string): string {
    if (source.includes(WORKTREE_SHELL_ENVIRONMENT_CACHE_MARKER)) return source;
    return source.replace(WORKTREE_SHELL_ENVIRONMENT_PATTERN, (_match, handlerSource) => {
      /**
       * 多个浏览器页会同时读取同一工作区的 shell 环境。复用完全相同的在途请求；失效挂载
       * 超过两秒仍未响应时先返回官方支持的 null fallback，底层成功后会自动刷新短期缓存。
       */
      return [
        `"worktree-shell-environment-config":((__opencodexHandler,${WORKTREE_SHELL_ENVIRONMENT_CACHE_MARKER})=>async(__opencodexArgs)=>{`,
        `if(process.env.${GATEWAY_RUNTIME_ENV}!==\`1\`)return __opencodexHandler(__opencodexArgs);`,
        `let __opencodexKey=JSON.stringify([__opencodexArgs.hostId,__opencodexArgs.cwd]),__opencodexNow=Date.now(),__opencodexCached=${WORKTREE_SHELL_ENVIRONMENT_CACHE_MARKER}.get(__opencodexKey);`,
        `if(__opencodexCached!=null&&(__opencodexCached.pending||__opencodexCached.expiresAt>__opencodexNow))return __opencodexCached.promise;`,
        `for(let[__opencodexOldKey,__opencodexOld]of ${WORKTREE_SHELL_ENVIRONMENT_CACHE_MARKER})if(!__opencodexOld.pending&&__opencodexOld.expiresAt<=__opencodexNow)${WORKTREE_SHELL_ENVIRONMENT_CACHE_MARKER}.delete(__opencodexOldKey);`,
        `if(${WORKTREE_SHELL_ENVIRONMENT_CACHE_MARKER}.size>=128){for(let[__opencodexOldKey,__opencodexOld]of ${WORKTREE_SHELL_ENVIRONMENT_CACHE_MARKER}){if(!__opencodexOld.pending)${WORKTREE_SHELL_ENVIRONMENT_CACHE_MARKER}.delete(__opencodexOldKey);if(${WORKTREE_SHELL_ENVIRONMENT_CACHE_MARKER}.size<128)break}if(${WORKTREE_SHELL_ENVIRONMENT_CACHE_MARKER}.size>=128)return{shellEnvironment:null}}`,
        `let __opencodexFallback={shellEnvironment:null},__opencodexEntry={expiresAt:0,pending:!0,promise:null,timedOut:!1,timer:null},__opencodexRaw=Promise.resolve().then(()=>__opencodexHandler(__opencodexArgs)),__opencodexTimeout=new Promise(__opencodexResolve=>{__opencodexEntry.timer=setTimeout(()=>{__opencodexEntry.timedOut=!0,__opencodexEntry.pending=!1,__opencodexEntry.expiresAt=Date.now()+6e4,__opencodexEntry.promise=Promise.resolve(__opencodexFallback),__opencodexResolve(__opencodexFallback)},2e3),__opencodexEntry.timer.unref?.()}),__opencodexPromise=Promise.race([__opencodexRaw,__opencodexTimeout]);`,
        `__opencodexEntry.promise=__opencodexPromise,${WORKTREE_SHELL_ENVIRONMENT_CACHE_MARKER}.set(__opencodexKey,__opencodexEntry),__opencodexRaw.then(__opencodexValue=>{clearTimeout(__opencodexEntry.timer),__opencodexEntry.pending=!1,__opencodexEntry.expiresAt=Date.now()+5e3,__opencodexEntry.promise=Promise.resolve(__opencodexValue)},()=>{clearTimeout(__opencodexEntry.timer);if(${WORKTREE_SHELL_ENVIRONMENT_CACHE_MARKER}.get(__opencodexKey)!==__opencodexEntry)return;if(__opencodexEntry.timedOut)__opencodexEntry.pending=!1,__opencodexEntry.expiresAt=Date.now()+6e4,__opencodexEntry.promise=Promise.resolve(__opencodexFallback);else ${WORKTREE_SHELL_ENVIRONMENT_CACHE_MARKER}.delete(__opencodexKey)});`,
        `return __opencodexPromise})(${handlerSource},new Map)`,
      ].join("");
    });
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
    GIT_ORIGINS_LOG_MARKER,
    GIT_BACKGROUND_TIMEOUT_PATTERN,
    GIT_ORIGIN_RESOLVER_PATTERN,
    GIT_LOCAL_PREFILTER_PATTERN,
    WORKTREE_SHELL_ENVIRONMENT_MARKER,
    WORKTREE_SHELL_ENVIRONMENT_PATTERN,
  },
};
