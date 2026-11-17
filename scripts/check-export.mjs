#!/usr/bin/env bun
// Fail when skills/slack-desktop no longer matches the hash recorded by the last
// export. This proves nothing was hand-edited here since that export; it does
// not prove the skill is current with its upstream copy.
import { join, resolve } from 'node:path';
import { SKILL, STAMP, treeHash } from './skill-tree.mjs';

const repo = resolve(import.meta.dir, '..');
const stampFile = Bun.file(join(repo, STAMP));
if (!(await stampFile.exists())) {
  console.error(`✗ ${STAMP} is missing; run scripts/export-skill.mjs from the upstream copy`);
  process.exit(1);
}
const stamp = await stampFile.json();
const actual = await treeHash(join(repo, 'skills', SKILL));
if (stamp.skill !== SKILL || stamp.sha256 !== actual) {
  console.error(
    `✗ skills/${SKILL} changed since the last export (expected ${String(stamp.sha256).slice(0, 12)}, found ${actual.slice(0, 12)}).\n` +
      '  Make the change in the upstream copy and run scripts/export-skill.mjs instead of editing here.'
  );
  process.exit(1);
}
console.log(`✔ skills/${SKILL} matches the last export (${actual.slice(0, 12)})`);
