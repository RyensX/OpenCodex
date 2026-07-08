const fs = require("fs");
const path = require("path");
const { Transform, Writable } = require("stream");
const { pipeline } = require("stream/promises");
const zlib = require("zlib");

class LocalArchiveError extends Error {
  constructor(message, status = 400, code = "archive_failed") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32Update(crc, buffer) {
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return crc >>> 0;
}

function crc32Finalize(crc) {
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(ms) {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now());
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | seconds,
  };
}

function writeUInt16(value) {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function writeUInt32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function assertZip32Size(value, label) {
  if (value > 0xffffffff) {
    throw new LocalArchiveError(`${label} is too large for zip32`, 413, "archive_too_large");
  }
}

function normalizedZipEntryName(value) {
  // ZIP 规范使用 / 分隔；过滤空段，避免生成绝对路径或 ../ 逃逸条目。
  return String(value || "")
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

function safeArchiveBaseName(value) {
  const name = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|\r\n]+/g, "_")
    .replace(/^\.+$/, "");
  return name || "folder";
}

function writeLocalFileHeader(fd, entry) {
  const name = Buffer.from(entry.name, "utf-8");
  const { date, time } = dosDateTime(entry.mtimeMs);
  const header = Buffer.concat([
    writeUInt32(0x04034b50),
    writeUInt16(20),
    writeUInt16(0x0800),
    writeUInt16(entry.method),
    writeUInt16(time),
    writeUInt16(date),
    writeUInt32(entry.crc),
    writeUInt32(entry.compressedSize),
    writeUInt32(entry.uncompressedSize),
    writeUInt16(name.length),
    writeUInt16(0),
    name,
  ]);
  fs.writeSync(fd, header);
}

function patchLocalFileHeader(fd, entry) {
  // 文件内容改成流式压缩后，CRC 和 size 只能在压缩结束后回填。
  const patch = Buffer.concat([writeUInt32(entry.crc), writeUInt32(entry.compressedSize), writeUInt32(entry.uncompressedSize)]);
  fs.writeSync(fd, patch, 0, patch.length, entry.offset + 14);
}

function centralDirectoryHeader(entry) {
  const name = Buffer.from(entry.name, "utf-8");
  const { date, time } = dosDateTime(entry.mtimeMs);
  return Buffer.concat([
    writeUInt32(0x02014b50),
    writeUInt16(20),
    writeUInt16(20),
    writeUInt16(0x0800),
    writeUInt16(entry.method),
    writeUInt16(time),
    writeUInt16(date),
    writeUInt32(entry.crc),
    writeUInt32(entry.compressedSize),
    writeUInt32(entry.uncompressedSize),
    writeUInt16(name.length),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt32(entry.directory ? 0x10 : 0),
    writeUInt32(entry.offset),
    name,
  ]);
}

function endOfCentralDirectory(entryCount, centralSize, centralOffset) {
  return Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(entryCount),
    writeUInt16(entryCount),
    writeUInt32(centralSize),
    writeUInt32(centralOffset),
    writeUInt16(0),
  ]);
}

function assertInsideDirectory(childPath, rootRealPath) {
  const childRealPath = fs.realpathSync.native ? fs.realpathSync.native(childPath) : fs.realpathSync(childPath);
  const relative = path.relative(rootRealPath, childRealPath);
  if (relative && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new LocalArchiveError("Archive entry escaped the selected directory", 400, "archive_path_escape");
  }
}

function createZipWriter(outputFile) {
  const fd = fs.openSync(outputFile, "w");
  const entries = [];
  let offset = 0;

  function writeBuffer(buffer) {
    fs.writeSync(fd, buffer);
    offset += buffer.length;
  }

  function addDirectory(name, mtimeMs) {
    const entryName = normalizedZipEntryName(name);
    if (!entryName) return;
    const directoryName = entryName.endsWith("/") ? entryName : `${entryName}/`;
    const entry = {
      compressedSize: 0,
      crc: 0,
      directory: true,
      method: 0,
      mtimeMs,
      name: directoryName,
      offset,
      uncompressedSize: 0,
    };
    writeLocalFileHeader(fd, entry);
    offset += 30 + Buffer.byteLength(entry.name);
    entries.push(entry);
  }

  async function addFile(name, filePath, stats) {
    const entryName = normalizedZipEntryName(name);
    if (!entryName) return;
    const entry = {
      compressedSize: 0,
      crc: 0,
      directory: false,
      method: 8,
      mtimeMs: stats.mtimeMs,
      name: entryName,
      offset,
      uncompressedSize: 0,
    };
    writeLocalFileHeader(fd, entry);
    offset += 30 + Buffer.byteLength(entry.name);
    let crc = 0xffffffff;
    if (stats.size > 0) {
      const crcTracker = new Transform({
        transform(chunk, encoding, callback) {
          try {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
            crc = crc32Update(crc, buffer);
            entry.uncompressedSize += buffer.length;
            callback(null, buffer);
          } catch (error) {
            callback(error);
          }
        },
      });
      const compressedWriter = new Writable({
        write(chunk, encoding, callback) {
          try {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
            assertZip32Size(offset + buffer.length, "Archive");
            fs.writeSync(fd, buffer);
            entry.compressedSize += buffer.length;
            offset += buffer.length;
            callback();
          } catch (error) {
            callback(error);
          }
        },
      });
      // 单文件内容不再整包读入内存，边读边压缩并直接写入临时 zip。
      await pipeline(fs.createReadStream(filePath), crcTracker, zlib.createDeflateRaw(), compressedWriter);
    }
    entry.crc = crc32Finalize(crc);
    assertZip32Size(entry.uncompressedSize, "File");
    assertZip32Size(entry.compressedSize, "Compressed file");
    patchLocalFileHeader(fd, entry);
    entries.push(entry);
  }

  function close() {
    const centralOffset = offset;
    const centralBuffers = entries.map(centralDirectoryHeader);
    const centralSize = centralBuffers.reduce((total, buffer) => total + buffer.length, 0);
    assertZip32Size(centralOffset, "Archive");
    assertZip32Size(centralSize, "Central directory");
    if (entries.length > 0xffff) {
      throw new LocalArchiveError("Archive contains too many entries", 413, "archive_too_many_files");
    }
    for (const buffer of centralBuffers) writeBuffer(buffer);
    writeBuffer(endOfCentralDirectory(entries.length, centralSize, centralOffset));
    fs.closeSync(fd);
  }

  function abort() {
    try {
      fs.closeSync(fd);
    } catch {}
  }

  return { abort, addDirectory, addFile, close };
}

async function createZipArchiveFromDirectory(sourceDir, outputFile, options = {}) {
  const maxFiles = Math.max(1, Number(options.maxFiles || 2000));
  const maxBytes = Math.max(1, Number(options.maxBytes || 100 * 1024 * 1024));
  const rootStats = fs.statSync(sourceDir);
  if (!rootStats.isDirectory()) {
    throw new LocalArchiveError("Selected path is not a directory", 400, "not_directory");
  }
  const rootRealPath = fs.realpathSync.native ? fs.realpathSync.native(sourceDir) : fs.realpathSync(sourceDir);
  const rootName = safeArchiveBaseName(path.basename(sourceDir));
  const writer = createZipWriter(outputFile);
  let fileCount = 0;
  let totalBytes = 0;

  async function addPath(currentPath, relativeName) {
    const stats = fs.lstatSync(currentPath);
    // 符号链接不跟随，避免把目录外部内容打包进远端下载。
    if (stats.isSymbolicLink()) return;
    assertInsideDirectory(currentPath, rootRealPath);
    if (stats.isDirectory()) {
      writer.addDirectory(relativeName, stats.mtimeMs);
      const entries = fs.readdirSync(currentPath, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name)
      );
      for (const entry of entries) {
        await addPath(path.join(currentPath, entry.name), `${relativeName}/${entry.name}`);
      }
      return;
    }
    if (!stats.isFile()) return;
    fileCount += 1;
    totalBytes += stats.size;
    if (fileCount > maxFiles) {
      throw new LocalArchiveError("Archive contains too many files", 413, "archive_too_many_files");
    }
    if (totalBytes > maxBytes) {
      throw new LocalArchiveError("Archive is too large", 413, "archive_too_large");
    }
    await writer.addFile(relativeName, currentPath, stats);
  }

  try {
    await addPath(rootRealPath, rootName);
    writer.close();
  } catch (error) {
    writer.abort();
    try {
      fs.rmSync(outputFile, { force: true });
    } catch {}
    throw error;
  }

  return { fileCount, outputFile, totalBytes };
}

module.exports = {
  LocalArchiveError,
  createZipArchiveFromDirectory,
  safeArchiveBaseName,
};
