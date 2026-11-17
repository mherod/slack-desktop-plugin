#!/usr/bin/env bun
// One-way export of the skill from its private upstream copy into this repo.
//
// Usage: bun scripts/export-skill.mjs <upstream-skills-root> [--dry-run]
//
// <upstream-skills-root> contains slack-desktop/ and the shared scripts/lib/.
// The export copies the skill without its private CLAUDE.md, vendors the shared
// test helper into scripts/lib/, runs .redaction/redact.mjs on that copy, then
// mirrors the result into skills/slack-desktop, deleting files removed
// upstream. It records only a content hash in skill-export.json, which
// check-export.mjs compares so that hand edits under skills/ fail CI.
//
// --dry-run builds the redacted copy and reports how it differs from the
// current skills/slack-desktop without writing anything. Exit 1 means it differs.
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { listFiles, SKILL, STAMP, treeHash } from './skill-tree.mjs';

const repo = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const upstream = args.find((arg) => !arg.startsWith('--'));
if (!upstream) {
  console.error('usage: bun scripts/export-skill.mjs <upstream-skills-root> [--dry-run]');
  process.exit(2);
}
const source = resolve(upstream, SKILL);
const helper = resolve(upstream, 'scripts/lib/atomic-file.mjs');
for (const required of [join(source, 'SKILL.md'), helper]) {
  if (!(await Bun.file(required).exists())) {
    console.error(`✗ ${required} not found; pass the upstream skills root`);
    process.exit(2);
  }
}

const work = await mkdtemp(join(tmpdir(), 'skill-export-'));
try {
  const built = join(work, SKILL);
  const skipped = new Set(['.DS_Store', 'node_modules']);
  await cp(source, built, {
    recursive: true,
    filter: (path) => !skipped.has(path.split('/').pop()),
  });
  // The private agent guide stays upstream.
  await rm(join(built, 'CLAUDE.md'), { force: true });
  await Bun.write(join(built, 'scripts/lib/atomic-file.mjs'), Bun.file(helper));
  const redact = Bun.spawnSync(['bun', join(repo, '.redaction/redact.mjs'), built], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (redact.exitCode !== 0) {
    console.error(`✗ redaction failed:\n${redact.stderr.toString()}`);
    process.exit(1);
  }

  const target = join(repo, 'skills', SKILL);
  const before = (await Bun.file(join(target, 'SKILL.md')).exists()) ? await listFiles(target) : [];
  const after = await listFiles(built);
  const removed = before.filter((file) => !after.includes(file));
  const added = after.filter((file) => !before.includes(file));
  const changed = [];
  for (const file of after.filter((file) => before.includes(file))) {
    const [next, current] = await Promise.all([
      Bun.file(join(built, file)).bytes(),
      Bun.file(join(target, file)).bytes(),
    ]);
    if (!Buffer.from(next).equals(Buffer.from(current))) changed.push(file);
  }
  for (const [label, files] of [
    ['added', added],
    ['removed', removed],
    ['changed', changed],
  ])
    for (const file of files) console.log(`${label}: skills/${SKILL}/${file}`);

  if (dryRun) {
    const same = !added.length && !removed.length && !changed.length;
    console.log(same ? `✔ export matches skills/${SKILL} (${after.length} files)` : '✗ export differs');
    process.exitCode = same ? 0 : 1;
  } else {
    const hash = await treeHash(built);
    await rm(target, { recursive: true, force: true });
    await cp(built, target, { recursive: true });
    await Bun.write(join(repo, STAMP), `${JSON.stringify({ skill: SKILL, sha256: hash }, null, 2)}\n`);
    console.log(`✔ exported ${after.length} files to skills/${SKILL}; ${STAMP} sha256 ${hash.slice(0, 12)}`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
