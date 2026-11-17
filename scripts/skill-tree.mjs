// Shared by export-skill.mjs and check-export.mjs: list a skill tree and hash it.
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const IGNORED = new Set(['.DS_Store', 'node_modules']);

/** Every regular file under `root`, as sorted POSIX-style relative paths. */
export async function listFiles(root) {
  const files = [];
  const walk = async (dir) => {
    for (const name of await readdir(dir)) {
      if (IGNORED.has(name)) continue;
      const path = join(dir, name);
      const info = await stat(path);
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) files.push(relative(root, path).split(sep).join('/'));
    }
  };
  await walk(root);
  return files.sort();
}

/** SHA-256 over every file's path and content, so any add, delete or edit changes it. */
export async function treeHash(root) {
  const hasher = new Bun.CryptoHasher('sha256');
  for (const file of await listFiles(root)) {
    const bytes = await Bun.file(join(root, file)).bytes();
    hasher.update(`${file}\0${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}\n`);
  }
  return hasher.digest('hex');
}

export const SKILL = 'slack-desktop';
export const STAMP = 'skill-export.json';
