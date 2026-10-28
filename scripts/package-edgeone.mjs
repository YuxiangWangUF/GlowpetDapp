import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { buildVisitor, PROJECT_ROOT } from './build-visitor.mjs';

// A small ZIP writer avoids an OS-specific archive command or an extra runtime.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const records = [], central = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const filename = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(bytes);
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12); // 1980-01-01, stable timestamp.
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10);
    directory.writeUInt16LE(0x21, 14); directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    records.push(local, filename, compressed); central.push(directory, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const directoryBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, directoryBytes, end]);
}

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out' || !args[1])) throw new Error('Usage: node scripts/package-edgeone.mjs [--out NEW_DIRECTORY]');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = args.length ? path.resolve(args[1]) : path.join(PROJECT_ROOT, 'output/releases', stamp);
try { await fs.lstat(output); throw new Error('Output already exists; choose a new release directory.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const dist = await buildVisitor();
const entries = [];
async function collect(directory) {
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error('Symlinks are not allowed in the upload package.');
    if (item.isDirectory()) { await collect(file); continue; }
    const name = path.relative(dist, file).replaceAll(path.sep, '/');
    if (name === '_headers') continue; // Converted to the native EdgeOne configuration below.
    if (item.name.startsWith('.') || /\.(?:map|key|pem)$/i.test(item.name)) throw new Error(`Unexpected private/debug file: ${name}`);
    const bytes = await fs.readFile(file);
    if (bytes.length >= 25 * 1024 * 1024) throw new Error(`File exceeds hosting limit: ${name}`);
    entries.push({ name, bytes });
  }
}
await collect(dist);
const config = await fs.readFile(path.join(PROJECT_ROOT, 'hosting/edgeone.json'));
JSON.parse(config.toString('utf8'));
entries.push({ name: 'edgeone.json', bytes: config });
entries.sort((a, b) => a.name.localeCompare(b.name));
if (entries.length > 20000 || entries.reduce((n, e) => n + e.bytes.length, 0) >= 0xffffffff) throw new Error('Release exceeds supported archive limits.');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.mkdir(output); // Never replace a previous release.
const archive = zip(entries);
const archivePath = path.join(output, 'Glowpet-EdgeOne.zip');
await fs.writeFile(archivePath, archive, { flag: 'wx' });
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({
  scope: 'visitor homepage and browser-local guest garden', uploaded: false, dnsChanged: false,
  archive: { file: 'Glowpet-EdgeOne.zip', bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex') },
  files: entries.map(({ name, bytes }) => ({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })),
}, null, 2) + '\n');
console.log(`Upload package created: ${archivePath}\n${entries.length} files; no upload or DNS change performed.`);
