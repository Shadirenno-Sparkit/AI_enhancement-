import { crc32 } from 'node:zlib';
import { deflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP writer.
 *
 * The export endpoint needs to hand the user a folder they can unzip on their
 * desktop, and that is the only archiving this server does — a self-contained
 * writer is cheaper than a dependency and has no surface beyond this file.
 * Produces a standard deflate archive readable by every OS unzip tool.
 */

export interface ZipEntry {
  /** Forward-slash path inside the archive. */
  path: string;
  content: Buffer;
  date?: Date;
}

/** MS-DOS date/time, the format the ZIP header expects. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function buildZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path.replace(/\\/g, '/'), 'utf8');
    const { time, date } = dosDateTime(entry.date ?? new Date());
    const checksum = crc32(entry.content) >>> 0;

    // Deflate unless it makes the entry bigger (already-compressed media).
    const deflated = deflateRawSync(entry.content, { level: 6 });
    const stored = deflated.byteLength >= entry.content.byteLength;
    const payload = stored ? entry.content : deflated;
    const method = stored ? 0 : 8;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(payload.byteLength, 18);
    localHeader.writeUInt32LE(entry.content.byteLength, 22);
    localHeader.writeUInt16LE(name.byteLength, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localParts.push(localHeader, name, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central directory signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(payload.byteLength, 20);
    centralHeader.writeUInt32LE(entry.content.byteLength, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // comment
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0o644 << 16, 38); // external attrs (unix mode)
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, name);
    offset += localHeader.byteLength + name.byteLength + payload.byteLength;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, central, end]);
}
