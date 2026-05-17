// @ts-nocheck
export {};

const crypto = require("crypto");
const path = require("path");

const SNAPSHOT_PREFIX = "opencodex-review-snapshot-v1";
const reviewSnapshots = new Map();

function splitLinesKeepEndings(text) {
  const lines = String(text || "").split(/(?<=\n)/);
  if (lines.length === 1 && lines[0] === "") return [];
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function fileTextToLines(text) {
  return splitLinesKeepEndings(text);
}

function snapshotOid(contents) {
  return crypto
    .createHash("sha1")
    .update(SNAPSHOT_PREFIX)
    .update("\0")
    .update(String(contents || ""))
    .digest("hex");
}

function registerReviewSnapshot(contents) {
  const text = String(contents || "");
  const oid = snapshotOid(text);
  reviewSnapshots.set(oid, { contents: text, lines: fileTextToLines(text) });
  return oid;
}

function getReviewSnapshot(oid) {
  if (typeof oid !== "string" || !oid.trim()) return null;
  return reviewSnapshots.get(oid.trim()) || null;
}

function toPosixPath(filePath) {
  return String(filePath || "").split(path.sep).join("/");
}

function isInside(basePath, candidatePath) {
  if (!basePath || !candidatePath) return false;
  const relative = path.relative(basePath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function diffPath(filePath, cwd) {
  if (typeof filePath !== "string" || !filePath.trim()) return null;
  const raw = filePath.trim();
  if (typeof cwd === "string" && cwd.trim() && path.isAbsolute(raw)) {
    const relative = path.relative(cwd.trim(), raw);
    if (relative && isInside(cwd.trim(), raw)) return toPosixPath(relative);
  }
  return toPosixPath(raw).replace(/^([ab])\//, "");
}

function ensureTrailingNewline(text) {
  const raw = String(text || "");
  return raw.length === 0 || raw.endsWith("\n") ? raw : `${raw}\n`;
}

function hunkLineCount(text) {
  return splitLinesKeepEndings(text).length;
}

function rawContentHunk(prefix, text, startHeader) {
  const lines = splitLinesKeepEndings(text);
  if (lines.length === 0) return "";
  return [
    startHeader(lines.length),
    ...lines.map((line) => `${prefix}${line.replace(/\r?\n$/, "")}`),
  ].join("\n") + "\n";
}

function parseHunkHeader(line) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) return null;
  return {
    oldStart: Number.parseInt(match[1], 10),
    oldCount: match[2] == null ? 1 : Number.parseInt(match[2], 10),
    newStart: Number.parseInt(match[3], 10),
    newCount: match[4] == null ? 1 : Number.parseInt(match[4], 10),
  };
}

function applyUnifiedHunks(oldText, hunkText) {
  const oldLines = splitLinesKeepEndings(oldText);
  const diffLines = splitLinesKeepEndings(hunkText);
  const newLines = [];
  let oldIndex = 0;
  let index = 0;
  let sawHunk = false;

  while (index < diffLines.length) {
    const line = diffLines[index];
    const header = parseHunkHeader(line);
    if (!header) {
      index += 1;
      continue;
    }
    sawHunk = true;
    const targetOldIndex = Math.max(0, header.oldStart - 1);
    while (oldIndex < targetOldIndex && oldIndex < oldLines.length) {
      newLines.push(oldLines[oldIndex]);
      oldIndex += 1;
    }
    index += 1;
    while (index < diffLines.length && !diffLines[index].startsWith("@@ ")) {
      const hunkLine = diffLines[index];
      const marker = hunkLine[0];
      if (marker === "\\") {
        index += 1;
        continue;
      }
      const content = hunkLine.slice(1);
      if (marker === " ") {
        newLines.push(oldLines[oldIndex] ?? content);
        oldIndex += 1;
      } else if (marker === "-") {
        oldIndex += 1;
      } else if (marker === "+") {
        newLines.push(content);
      }
      index += 1;
    }
  }

  if (!sawHunk) return null;
  while (oldIndex < oldLines.length) {
    newLines.push(oldLines[oldIndex]);
    oldIndex += 1;
  }
  return newLines.join("");
}

function fileHeader({ type, oldPath, newPath, oldOid, newOid }) {
  const lines = [`diff --git a/${oldPath} b/${newPath}`];
  if (type === "add") lines.push("new file mode 100644");
  if (type === "delete") lines.push("deleted file mode 100644");
  if (oldOid || newOid) lines.push(`index ${oldOid || "0000000"}..${newOid || "0000000"} 100644`);
  lines.push(type === "add" ? "--- /dev/null" : `--- a/${oldPath}`);
  lines.push(type === "delete" ? "+++ /dev/null" : `+++ b/${newPath}`);
  return `${lines.join("\n")}\n`;
}

function buildDiffForChange(change, cwd, virtualFiles) {
  if (!change || typeof change !== "object" || typeof change.path !== "string") return null;
  const kind = change.kind && typeof change.kind === "object" ? change.kind : {};
  const type = typeof kind.type === "string" ? kind.type : "";
  const newPath = diffPath(change.path, cwd);
  if (!newPath) return null;
  const oldPath = type === "update" && typeof kind.move_path === "string" && kind.move_path
    ? diffPath(kind.move_path, cwd) || newPath
    : newPath;
  const rawDiff = String(change.diff || "");
  const currentVirtual = virtualFiles ? virtualFiles.get(newPath) : null;

  if (type === "add") {
    const newText = rawDiff;
    const newOid = registerReviewSnapshot(newText);
    if (virtualFiles) virtualFiles.set(newPath, newText);
    return `${fileHeader({ type: "add", oldPath, newPath, newOid })}${rawContentHunk("+", newText, (count) => `@@ -0,0 +1,${count} @@`)}`;
  }

  if (type === "delete") {
    const oldText = currentVirtual ?? rawDiff;
    const oldOid = registerReviewSnapshot(oldText);
    if (virtualFiles) virtualFiles.delete(oldPath);
    return `${fileHeader({ type: "delete", oldPath, newPath, oldOid })}${rawContentHunk("-", oldText, (count) => `@@ -1,${count} +0,0 @@`)}`;
  }

  if (type === "update") {
    const hunk = ensureTrailingNewline(rawDiff);
    const oldText = currentVirtual;
    const newText = oldText == null ? null : applyUnifiedHunks(oldText, hunk);
    const oldOid = oldText == null ? null : registerReviewSnapshot(oldText);
    const newOid = newText == null ? null : registerReviewSnapshot(newText);
    if (virtualFiles && newText != null) {
      if (oldPath !== newPath) virtualFiles.delete(oldPath);
      virtualFiles.set(newPath, newText);
    }
    return `${fileHeader({ type: "update", oldPath, newPath, oldOid, newOid })}${hunk}`;
  }

  return null;
}

function synthesizeTurnDiff(turn, cwd, virtualFiles) {
  if (!turn || typeof turn !== "object") return null;
  if (typeof turn.diff === "string" && turn.diff.trim()) return null;
  const items = Array.isArray(turn.items) ? turn.items : [];
  const parts = [];
  for (const item of items) {
    if (!item || item.type !== "fileChange" || item.status !== "completed") continue;
    for (const change of Array.isArray(item.changes) ? item.changes : []) {
      const diff = buildDiffForChange(change, cwd, virtualFiles);
      if (diff) parts.push(diff);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function enrichTurnForReviewDiff(turn, cwd, virtualFiles) {
  const diff = synthesizeTurnDiff(turn, cwd, virtualFiles);
  return diff == null ? turn : { ...turn, diff };
}

function enrichThreadForReviewDiff(thread) {
  if (!thread || typeof thread !== "object" || !Array.isArray(thread.turns)) return thread;
  const cwd = typeof thread.cwd === "string" && thread.cwd ? thread.cwd : null;
  const virtualFiles = new Map();
  let changed = false;
  const turns = thread.turns.map((turn) => {
    const enriched = enrichTurnForReviewDiff(turn, turn?.params?.cwd || cwd, virtualFiles);
    if (enriched !== turn) changed = true;
    return enriched;
  });
  return changed ? { ...thread, turns } : thread;
}

function enrichTurnListForReviewDiff(turns) {
  if (!Array.isArray(turns)) return turns;
  const virtualFiles = new Map();
  let changed = false;
  const next = turns.map((turn) => {
    const enriched = enrichTurnForReviewDiff(turn, turn?.params?.cwd || null, virtualFiles);
    if (enriched !== turn) changed = true;
    return enriched;
  });
  return changed ? next : turns;
}

function enrichNotificationForReviewDiff(method, payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (method !== "turn/completed" && method !== "turn/started") return payload;
  if (!payload.turn || typeof payload.turn !== "object") return payload;
  const turn = enrichTurnForReviewDiff(payload.turn, payload.turn?.params?.cwd || null, null);
  return turn === payload.turn ? payload : { ...payload, turn };
}

module.exports = {
  enrichNotificationForReviewDiff,
  enrichThreadForReviewDiff,
  enrichTurnListForReviewDiff,
  enrichTurnForReviewDiff,
  fileTextToLines,
  getReviewSnapshot,
  registerReviewSnapshot,
};
