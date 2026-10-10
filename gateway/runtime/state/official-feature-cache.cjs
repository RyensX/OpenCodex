const fs = require("node:fs");
const path = require("node:path");

const MAX_BYTES = 32 * 1024 * 1024;
const LOG_BLOCK_BYTES = 32768;
const TABLE_MAGIC = 0xdb4775248b80fb57n;
const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0x82f63b78 : 0);
  CRC_TABLE[index] = value >>> 0;
}

/** LevelDB 使用 masked CRC32C；损坏记录不能成为功能开关真源。 */
function checksumMatches(data, checksum, prefix = null) {
  let crc = 0xffffffff;
  if (prefix !== null) crc = CRC_TABLE[(crc ^ prefix) & 255] ^ (crc >>> 8);
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  crc = (~crc) >>> 0;
  const masked = (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
  return masked === checksum;
}

/** 所有长度和偏移均先做安全整数检查，再用于 Buffer 分配与切片。 */
function readVarint(data, cursor) {
  let value = 0n;
  for (let index = 0; index < 10; index += 1) {
    if (cursor.offset >= data.length) throw new Error("Incomplete varint");
    const byte = data[cursor.offset++];
    if (index === 9 && byte > 1) throw new Error("Invalid varint");
    value |= BigInt(byte & 127) << BigInt(index * 7);
    if (byte < 128) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe length or offset");
      return Number(value);
    }
  }
  throw new Error("Invalid varint");
}

function readSlice(data, cursor) {
  // 长度前缀不能越过当前记录边界，截断写入只影响该记录。
  const length = readVarint(data, cursor);
  if (length > MAX_BYTES || cursor.offset + length > data.length) throw new Error("Invalid slice");
  const value = data.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return value;
}

/** 只读打开文件，不创建数据库锁、恢复日志或写入官方 profile。 */
function readBoundedFile(filePath) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (read === 0) return null;
      offset += read;
    }
    return buffer;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** 按 32KB 日志块重组 FULL/FIRST/MIDDLE/LAST，丢弃校验失败及未写完的尾记录。 */
function* logRecords(data) {
  let fragments = [];
  let fragmentBytes = 0;
  for (let blockStart = 0; blockStart < data.length; blockStart += LOG_BLOCK_BYTES) {
    const blockEnd = Math.min(data.length, blockStart + LOG_BLOCK_BYTES);
    let offset = blockStart;
    while (offset + 7 <= blockEnd) {
      const checksum = data.readUInt32LE(offset);
      const length = data.readUInt16LE(offset + 4);
      const type = data[offset + 6];
      offset += 7;
      if (type === 0 && length === 0) break;
      if (offset + length > blockEnd) {
        fragments = [];
        fragmentBytes = 0;
        break;
      }
      const fragment = data.subarray(offset, offset + length);
      offset += length;
      // 日志 CRC 覆盖记录类型和数据；不同于 SST 数据块的尾部类型。
      if (!checksumMatches(fragment, checksum, type)) {
        fragments = [];
        fragmentBytes = 0;
        continue;
      }
      if (type === 1) {
        fragments = [];
        fragmentBytes = 0;
        yield fragment;
      } else if (type === 2) {
        fragments = [fragment];
        fragmentBytes = length;
      } else if ((type === 3 || type === 4) && fragments.length > 0) {
        fragmentBytes += length;
        if (fragmentBytes > MAX_BYTES) {
          fragments = [];
          fragmentBytes = 0;
          continue;
        }
        fragments.push(fragment);
        if (type === 4) {
          yield Buffer.concat(fragments, fragmentBytes);
          fragments = [];
          fragmentBytes = 0;
        }
      } else {
        fragments = [];
        fragmentBytes = 0;
      }
    }
  }
}

/** CURRENT/MANIFEST 指定当前有效 SST，避免已经淘汰的旧文件复活被删除的缓存。 */
function readLiveFiles(directory) {
  // CURRENT 只允许 LevelDB 自己的清单文件名，不能逃逸到 profile 外部。
  const current = readBoundedFile(path.join(directory, "CURRENT"));
  const manifestName = current?.toString("ascii").trim();
  if (!/^MANIFEST-\d+$/.test(manifestName || "")) return null;
  // 读取当前清单的完整版本编辑；未写完的最后一条记录不参与恢复。
  const manifest = readBoundedFile(path.join(directory, manifestName));
  if (!manifest) return null;
  const tables = new Set();
  let logNumber = null;
  let previousLog = 0;
  let records = 0;
  // 使用官方 VersionEdit tag，不猜测未知格式或自定义 comparator。
  for (const record of logRecords(manifest)) {
    const cursor = { offset: 0 };
    const edits = [];
    while (cursor.offset < record.length) {
      // 单条记录全部解析成功后才应用，损坏的编辑不能改变 live file 集合。
      const tag = readVarint(record, cursor);
      if (tag === 1) {
        // Chromium LocalStorage 使用字节序比较器。
        const comparator = readSlice(record, cursor);
        if (comparator.toString("ascii") !== "leveldb.BytewiseComparator") return null;
      } else if (tag === 2 || tag === 9) {
        // 记录当前日志及上一日志，过滤旧日志中的过期缓存。
        edits.push([tag, readVarint(record, cursor)]);
      } else if (tag === 3 || tag === 4) {
        // 文件号和最后 sequence 不改变需要读取的文件集合。
        readVarint(record, cursor);
      } else if (tag === 5) {
        // compaction pointer 包含 level 与 internal key。
        readVarint(record, cursor);
        // 指针仅用于压缩进度，与缓存内容无关。
        readSlice(record, cursor);
      } else if (tag === 6 || tag === 7) {
        // 删除/新增文件均由 level 与文件号标识。
        readVarint(record, cursor);
        // 文件编号用于关联实际 SST 文件名。
        const number = readVarint(record, cursor);
        if (tag === 7) {
          // 跳过文件大小及首尾 internal key，索引将由 SST 自身读取。
          readVarint(record, cursor);
          // 最小 internal key 的长度前缀需完整。
          readSlice(record, cursor);
          // 最大 internal key 同样检查边界。
          readSlice(record, cursor);
        }
        edits.push([tag, number]);
      } else {
        return null;
      }
    }
    for (const [tag, number] of edits) {
      if (tag === 2) logNumber = number;
      else if (tag === 9) previousLog = number;
      else if (tag === 6) tables.delete(number);
      else if (tag === 7) tables.add(number);
    }
    records += 1;
  }
  return records > 0 && logNumber !== null ? { tables, logNumber, previousLog } : null;
}

/** 解码 Snappy 原始块；重叠 copy 必须逐字节展开，输出总量严格受限。 */
function decompressSnappy(data, maximum) {
  const cursor = { offset: 0 };
  // 原始 Snappy 以未压缩长度的 varint 开头。
  const size = readVarint(data, cursor);
  if (size > maximum || size > MAX_BYTES) throw new Error("Snappy output exceeds limit");
  const output = Buffer.alloc(size);
  let written = 0;
  while (cursor.offset < data.length && written < size) {
    const tag = data[cursor.offset++];
    const type = tag & 3;
    let length = (tag >>> 2) + 1;
    if (type === 0) {
      if (length > 60) {
        const bytes = length - 60;
        if (cursor.offset + bytes > data.length) throw new Error("Incomplete Snappy literal");
        length = data.readUIntLE(cursor.offset, bytes) + 1;
        cursor.offset += bytes;
      }
      if (written + length > size || cursor.offset + length > data.length) throw new Error("Invalid literal length");
      data.copy(output, written, cursor.offset, cursor.offset + length);
      cursor.offset += length;
      written += length;
      continue;
    }
    let offset;
    if (type === 1) {
      if (cursor.offset >= data.length) throw new Error("Incomplete Snappy copy");
      length = ((tag >>> 2) & 7) + 4;
      offset = ((tag & 224) << 3) | data[cursor.offset++];
    } else {
      const bytes = type === 2 ? 2 : 4;
      if (cursor.offset + bytes > data.length) throw new Error("Incomplete Snappy copy");
      offset = data.readUIntLE(cursor.offset, bytes);
      cursor.offset += bytes;
    }
    if (offset === 0 || offset > written || written + length > size) throw new Error("Invalid Snappy offset");
    for (let index = 0; index < length; index += 1) {
      output[written] = output[written - offset];
      written += 1;
    }
  }
  if (written !== size || cursor.offset !== data.length) throw new Error("Incomplete Snappy block");
  return output;
}

/** SST 条目使用前缀压缩，块尾为 restart 数组；所有条目必须止于 restart 区之前。 */
function* blockEntries(block) {
  if (block.length < 4) throw new Error("Incomplete data block");
  const count = block.readUInt32LE(block.length - 4);
  const end = block.length - 4 - count * 4;
  if (count < 1 || end < 0) throw new Error("Invalid restart array");
  let previousRestart = -1;
  for (let index = 0; index < count; index += 1) {
    const restart = block.readUInt32LE(end + index * 4);
    if (restart > end || restart <= previousRestart || (index === 0 && restart !== 0)) throw new Error("Invalid restart offset");
    previousRestart = restart;
  }
  const data = block.subarray(0, end);
  const cursor = { offset: 0 };
  let key = Buffer.alloc(0);
  while (cursor.offset < end) {
    // 根据上一条 key 的共享前缀重建当前 internal key。
    const shared = readVarint(data, cursor);
    // 剩余 key 和 value 的长度来自同一条记录。
    const unshared = readVarint(data, cursor);
    // 数据值也要限制在块内。
    const valueLength = readVarint(data, cursor);
    if (shared > key.length || shared + unshared > MAX_BYTES || cursor.offset + unshared + valueLength > end) {
      throw new Error("Invalid block entry");
    }
    key = Buffer.concat([key.subarray(0, shared), data.subarray(cursor.offset, cursor.offset + unshared)]);
    cursor.offset += unshared;
    const value = data.subarray(cursor.offset, cursor.offset + valueLength);
    cursor.offset += valueLength;
    yield { key, value };
  }
}

/** 数据块尾的 CRC 包含压缩类型，防止损坏内容被当作有效身份缓存。 */
function readTableBlock(file, handle, budget) {
  const cursor = { offset: 0 };
  // BlockHandle 由 offset/size 两个 varint64 构成。
  const offset = readVarint(handle, cursor);
  // 只有文件内的块允许解码。
  const size = readVarint(handle, cursor);
  if (size > MAX_BYTES || offset + size + 5 > file.length - 48) throw new Error("Invalid block handle");
  const bytes = file.subarray(offset, offset + size);
  const compression = file[offset + size];
  // SST 的校验覆盖数据及尾部 compression 字节。
  if (!checksumMatches(file.subarray(offset, offset + size + 1), file.readUInt32LE(offset + size + 1))) {
    throw new Error("Invalid block checksum");
  }
  let output;
  if (compression === 0) output = bytes;
  else if (compression === 1) {
    // 共享每个文件的解压预算，避免大量压缩块绕过单块上限。
    output = decompressSnappy(bytes, MAX_BYTES - budget.bytes);
  } else throw new Error("Unsupported table compression");
  budget.bytes += output.length;
  if (budget.bytes > MAX_BYTES) throw new Error("Table output exceeds limit");
  return output;
}

/** 仅保留 Statsig evaluations 用户键；其他本机存储内容不进入结果集合。 */
function rememberEntry(latest, key, sequence, type, value) {
  // Chromium LocalStorage 键为 _origin\0 + 字符串编码标记 + key。
  if (key[0] !== 95 || (type !== 0 && type !== 1)) return;
  const separator = key.indexOf(0);
  if (separator < 0 || separator + 2 > key.length) return;
  const encoding = key[separator + 1];
  if (encoding !== 0 && encoding !== 1) return;
  const text = key.subarray(separator + 2).toString(encoding === 0 ? "utf16le" : "latin1");
  if (!text.startsWith("statsig.cached.evaluations.")) return;
  const identifier = key.toString("hex");
  const prior = latest.get(identifier);
  // tombstone 同样占据最高 sequence，不能回退到旧 put。
  if (prior && prior.sequence >= sequence) return;
  latest.set(identifier, { sequence, type, value: type === 1 ? Buffer.from(value) : null });
}

/** WAL 的 WriteBatch 必须完整解码，再原子合入 sequence 视图。 */
function readWriteBatch(record, latest) {
  if (record.length < 12) throw new Error("Incomplete WriteBatch");
  const sequence = record.readBigUInt64LE(0);
  const count = record.readUInt32LE(8);
  if (count > record.length - 12) throw new Error("Invalid WriteBatch count");
  const cursor = { offset: 12 };
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (cursor.offset >= record.length) throw new Error("Incomplete WriteBatch entry");
    const type = record[cursor.offset++];
    if (type !== 0 && type !== 1) throw new Error("Invalid WriteBatch type");
    // 所有类型均带用户键，put 额外带值。
    const key = readSlice(record, cursor);
    // delete 没有值，尊重原始 tombstone。
    const value = type === 1 ? readSlice(record, cursor) : null;
    entries.push({ key, type, value });
  }
  if (cursor.offset !== record.length) throw new Error("Trailing WriteBatch bytes");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    // 每次操作使用 batch 基准 sequence 加操作索引。
    rememberEntry(latest, entry.key, sequence + BigInt(index), entry.type, entry.value);
  }
}

/** 通过 SST 索引寻找数据块；只有整个文件完整可读时才合入全局最新视图。 */
function readTable(file, latest) {
  if (file.length < 48 || file.readBigUInt64LE(file.length - 8) !== TABLE_MAGIC) throw new Error("Invalid table footer");
  const footer = file.subarray(file.length - 48, file.length - 8);
  const cursor = { offset: 0 };
  // 跳过 metaindex BlockHandle，后一个 handle 为 index。
  readVarint(footer, cursor);
  // metaindex 的 size 同样是 varint64。
  readVarint(footer, cursor);
  const budget = { bytes: 0 };
  const pending = new Map();
  // 索引自身可以为 Snappy 压缩块。
  const index = readTableBlock(file, footer.subarray(cursor.offset), budget);
  // 每个 index value 是一个数据块的 BlockHandle。
  for (const handle of blockEntries(index)) {
    // 按官方 block trailer 校验后再解压对应数据块。
    const block = readTableBlock(file, handle.value, budget);
    // internal key 最后八字节打包 sequence 与删除/写入类型。
    for (const entry of blockEntries(block)) {
      if (entry.key.length < 8) throw new Error("Invalid internal key");
      const tag = entry.key.readBigUInt64LE(entry.key.length - 8);
      // 只收集目标键，其他存储值在块迭代结束后释放。
      rememberEntry(pending, entry.key.subarray(0, entry.key.length - 8), tag >> 8n, Number(tag & 255n), entry.value);
    }
  }
  for (const [key, entry] of pending) {
    const prior = latest.get(key);
    if (!prior || entry.sequence > prior.sequence) latest.set(key, entry);
  }
}

/** 返回当前身份的原始功能开关映射，不暴露用户字段、认证信息或缓存全文。 */
function readOfficialFeatureCache(profileRoot, identity) {
  if (typeof profileRoot !== "string" || !profileRoot || !identity) return null;
  for (const field of ["accountId", "userId", "appVersion", "locale"]) {
    if (typeof identity[field] !== "string" || !identity[field]) return null;
  }
  const directory = path.join(profileRoot, "Default", "Local Storage", "leveldb");
  const latest = new Map();
  try {
    // 按当前 MANIFEST 选择有效数据，不对原数据库执行 recovery 或加锁。
    const live = readLiveFiles(directory);
    if (!live) return null;
    for (const name of fs.readdirSync(directory)) {
      const match = /^(\d+)\.(ldb|sst|log)$/.exec(name);
      if (!match) continue;
      const number = Number(match[1]);
      const isLog = match[2] === "log";
      if (isLog ? number < live.logNumber && number !== live.previousLog : !live.tables.has(number)) continue;
      // 单文件超过上限或正在替换时跳过，绝不扩大文件读取预算。
      const file = readBoundedFile(path.join(directory, name));
      if (!file) continue;
      if (isLog) {
        // 尾部未完成的 batch 会被跳过，已提交的完整记录继续按 sequence 合并。
        for (const record of logRecords(file)) {
          try {
            // 每个完整日志记录承载一个 WriteBatch。
            readWriteBatch(record, latest);
          } catch {
            // 损坏 batch 不能部分应用。
          }
        }
      } else {
        try {
          // SST 由 footer/index 定位，不扫描压缩正文中的文本碎片。
          readTable(file, latest);
        } catch {
          // 压缩类型未知、损坏或压缩炸弹均不能成为开关来源。
        }
      }
    }
    let selected = null;
    let selectedSequence = -1n;
    for (const entry of latest.values()) {
      if (entry.type !== 1 || !entry.value?.length || entry.sequence <= selectedSequence) continue;
      try {
        const encoding = entry.value[0];
        if (encoding !== 0 && encoding !== 1) continue;
        const raw = entry.value.subarray(1).toString(encoding === 0 ? "utf16le" : "latin1");
        const cached = JSON.parse(raw);
        const payload = typeof cached.data === "string" ? JSON.parse(cached.data) : null;
        const user = payload?.user;
        // 登录态缓存必须精确匹配身份；匿名缓存只同步设备级导航和队列协议，不复用账号功能。
        let anonymousDeviceCache = false;
        if (user) {
          if (user.userID !== identity.userId || user.customIDs?.account_id !== identity.accountId
              || user.appVersion !== identity.appVersion || user.locale !== identity.locale) continue;
        } else {
          const evaluated = payload?.evaluated_keys;
          const customIds = evaluated?.customIDs;
          const derived = payload?.derived_fields;
          if (typeof identity.stableId !== "string" || !identity.stableId
              || evaluated?.userID != null || customIds?.account_id != null
              || cached.stableID !== identity.stableId || customIds?.stableID !== identity.stableId
              || derived?.appVersion !== identity.appVersion || derived?.locale !== identity.locale) continue;
          anonymousDeviceCache = true;
        }
        const gates = payload.feature_gates;
        if (!gates || typeof gates !== "object" || Array.isArray(gates)) continue;
        // 匿名缓存缺少导航评估时不能覆盖先前已匹配的有效评估。
        if (anonymousDeviceCache && typeof gates["3085093835"]?.value !== "boolean") continue;
        // 导航与本地服务端队列必须和桌面保持一致，否则服务端接收后临时队列清空，Web 却无法显示。
        selected = gates;
        if (anonymousDeviceCache) {
          selected = {};
          // 仅复制已验证设备的实际布尔值，不固定开启，也不传递其他账号功能。
          for (const name of ["3085093835", "2120612410"]) {
            if (typeof gates[name]?.value === "boolean") selected[name] = gates[name];
          }
        }
        selectedSequence = entry.sequence;
      } catch {
        // 未完整写入或旧 SDK 形态继续回退为无可靠缓存。
      }
    }
    return selected;
  } catch {
    return null;
  }
}

module.exports = { readOfficialFeatureCache };
