import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function git(repository, args, options = {}) {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function resolveCommit(repository, revision) {
  return git(repository, ['rev-parse', '--verify', `${revision}^{commit}`]).trim();
}

export function listRevisionFiles(repository, revision) {
  return git(repository, ['ls-tree', '-r', '-z', '--name-only', revision])
    .split('\0')
    .filter(Boolean)
    .sort();
}

export function readRevisionFile(repository, revision, path) {
  return git(repository, ['show', `${revision}:${path}`], { encoding: 'buffer' });
}

export function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function framedContentDigest(files) {
  const hash = createHash('sha256');
  for (const file of files) {
    const path = Buffer.from(file.path);
    const pathLength = Buffer.alloc(4);
    const contentLength = Buffer.alloc(8);
    pathLength.writeUInt32BE(path.length);
    contentLength.writeBigUInt64BE(BigInt(file.bytes.length));
    hash.update(pathLength).update(path).update(contentLength).update(file.bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function framedPathSetDigest(paths) {
  const hash = createHash('sha256');
  for (const value of paths) {
    const path = Buffer.from(value);
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(path.length);
    hash.update(pathLength).update(path);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function revisionFileMode(repository, revision, path) {
  const line = git(repository, ['ls-tree', revision, '--', path]).trim();
  const match = /^(\d{6})\s+blob\s+[0-9a-f]+\t/u.exec(line);
  if (!match) throw new Error(`Expected an exact Git blob at ${revision}: ${path}`);
  return match[1];
}

export function assertSafeRepositoryPath(path) {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.split('/').includes('..') ||
    path.includes('\\') ||
    path.includes('\0')
  ) {
    throw new Error(`Unsafe repository-relative path: ${JSON.stringify(path)}`);
  }
}
