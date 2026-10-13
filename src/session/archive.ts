import { createHash } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";

import { PolicyDeniedError } from "../errors.js";
import {
  MAX_SESSION_ARCHIVE_BYTES,
  MAX_SESSION_MANIFEST_BYTES,
  MAX_SESSION_PAYLOAD_BYTES,
  SESSION_MANIFEST_FILE,
  SESSION_PAYLOAD_FILE,
  parseSessionManifest,
  type SessionCheckpoint,
} from "./contracts.js";

function denied(message: string): never {
  throw new PolicyDeniedError(message);
}
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Restricted SDK ZIP format: exactly two regular files; no extraction to runner paths. */
export function decodeSessionArchive(input: Uint8Array, now = Date.now()): SessionCheckpoint {
  const bytes = Buffer.from(input);
  if (bytes.length < 22 || bytes.length > MAX_SESSION_ARCHIVE_BYTES)
    denied("Session artifact archive exceeds its size bound");
  const end = bytes.length - 22;
  if (
    bytes.readUInt32LE(end) !== 0x06054b50 ||
    bytes.readUInt16LE(end + 20) !== 0 ||
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    bytes.readUInt16LE(end + 8) !== 2 ||
    bytes.readUInt16LE(end + 10) !== 2
  )
    denied("Session artifact must be one non-ZIP64 archive with exactly two files");
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralStart = bytes.readUInt32LE(end + 16);
  if (centralStart + centralSize !== end)
    denied("Session ZIP central directory does not match its archive");
  let position = centralStart;
  const files = new Map<string, Buffer>();
  const ranges: { start: number; end: number }[] = [];
  for (let index = 0; index < 2; index++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50)
      denied("Session ZIP file metadata is invalid");
    const flags = bytes.readUInt16LE(position + 8);
    const method = bytes.readUInt16LE(position + 10);
    const checksum = bytes.readUInt32LE(position + 16);
    const compressed = bytes.readUInt32LE(position + 20);
    const uncompressed = bytes.readUInt32LE(position + 24);
    const nameLength = bytes.readUInt16LE(position + 28);
    const extraLength = bytes.readUInt16LE(position + 30);
    const commentLength = bytes.readUInt16LE(position + 32);
    const external = bytes.readUInt32LE(position + 38);
    const local = bytes.readUInt32LE(position + 42);
    const next = position + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      flags & ~0x0808 ||
      ![0, 8].includes(method) ||
      bytes.readUInt16LE(position + 34) !== 0 ||
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff ||
      local === 0xffffffff
    )
      denied("Session ZIP encryption, split archives or unsupported compression are forbidden");
    const mode = (external >>> 16) & 0xf000;
    if ((mode !== 0 && mode !== 0x8000) || (external & 0x10) !== 0)
      denied("Session ZIP entries must be regular files, never symlinks or directories");
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(position + 46, position + 46 + nameLength),
      );
    } catch {
      denied("Session ZIP filenames must be valid UTF-8");
    }
    if (![SESSION_MANIFEST_FILE, SESSION_PAYLOAD_FILE].includes(name) || files.has(name))
      denied("Session ZIP contains an unexpected or duplicate file");
    const maximum =
      name === SESSION_MANIFEST_FILE ? MAX_SESSION_MANIFEST_BYTES : MAX_SESSION_PAYLOAD_BYTES;
    if (uncompressed < 1 || uncompressed > maximum || compressed > MAX_SESSION_ARCHIVE_BYTES)
      denied("Session ZIP declared file size exceeds its bound");
    if (
      local + 30 > centralStart ||
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method
    )
      denied("Session ZIP local file header does not match");
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    if (
      dataStart + compressed > centralStart ||
      !bytes.subarray(local + 30, local + 30 + localNameLength).equals(Buffer.from(name))
    )
      denied("Session ZIP local filename or data range does not match");
    let dataEnd = dataStart + compressed;
    if ((flags & 8) !== 0) {
      if (dataEnd + 12 > centralStart) denied("Session ZIP data descriptor is missing");
      if (bytes.readUInt32LE(dataEnd) === 0x08074b50) dataEnd += 4;
      if (
        dataEnd + 12 > centralStart ||
        bytes.readUInt32LE(dataEnd) !== checksum ||
        bytes.readUInt32LE(dataEnd + 4) !== compressed ||
        bytes.readUInt32LE(dataEnd + 8) !== uncompressed
      )
        denied("Session ZIP data descriptor does not match");
      dataEnd += 12;
    } else if (
      bytes.readUInt32LE(local + 14) !== checksum ||
      bytes.readUInt32LE(local + 18) !== compressed ||
      bytes.readUInt32LE(local + 22) !== uncompressed
    )
      denied("Session ZIP local size or checksum does not match");
    let content: Buffer;
    try {
      content =
        method === 0
          ? Buffer.from(bytes.subarray(dataStart, dataStart + compressed))
          : inflateRawSync(bytes.subarray(dataStart, dataStart + compressed), {
              maxOutputLength: uncompressed,
            });
    } catch {
      denied("Session ZIP decompression failed or exceeded its declared byte bound");
    }
    if (content.length !== uncompressed || crc32(content) !== checksum)
      denied("Session ZIP file size or checksum is inconsistent");
    files.set(name, content);
    ranges.push({ start: local, end: dataEnd });
    position = next;
  }
  ranges.sort((a, b) => a.start - b.start);
  if (
    position !== end ||
    ranges[0]?.start !== 0 ||
    ranges[0].end !== ranges[1]?.start ||
    ranges[1].end !== centralStart
  )
    denied("Session ZIP contains overlapping or unlisted data entries");
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(files.get(SESSION_MANIFEST_FILE)),
    );
  } catch {
    denied("Session manifest must contain valid UTF-8 JSON");
  }
  const manifest = parseSessionManifest(value, now);
  const payload = files.get(SESSION_PAYLOAD_FILE);
  if (payload?.length !== manifest.payload.bytes || digest(payload) !== manifest.payload.sha256)
    denied("Session payload size or SHA256 differs from its manifest");
  return { manifest, payload };
}
