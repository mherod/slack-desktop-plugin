#!/usr/bin/env bun
// Fail when plugin.json, marketplace.json and package.json disagree on name or version.
const read = (path) => Bun.file(new URL(`../${path}`, import.meta.url)).json();

const [plugin, marketplace, pkg] = await Promise.all([
  read('.claude-plugin/plugin.json'),
  read('.claude-plugin/marketplace.json'),
  read('package.json'),
]);

const entry = marketplace.plugins?.find((p) => p.name === plugin.name);
const errors = [];
if (!entry) errors.push(`marketplace.json has no plugin entry named "${plugin.name}"`);
else if (entry.version !== plugin.version)
  errors.push(`marketplace.json version ${entry.version} != plugin.json version ${plugin.version}`);
if (pkg.version !== plugin.version)
  errors.push(`package.json version ${pkg.version} != plugin.json version ${plugin.version}`);

if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  process.exit(1);
}
console.log(`✔ ${plugin.name} ${plugin.version}: manifests agree`);

const [portable, codex, catalog] = await Promise.all([
  read('plugin.json'),
  read('.codex-plugin/plugin.json'),
  read('.agents/plugins/marketplace.json'),
]);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
for (const [name, manifest] of Object.entries({ portable, codex })) {
  assert(manifest.name === plugin.name, `${name}: plugin name differs`);
  assert(manifest.version === plugin.version, `${name}: plugin version differs`);
}
assert(portable.$schema === 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'Missing portable schema');
assert(codex.skills === './skills/', 'Codex must load bundled skills');
assert(JSON.stringify(portable.extensions?.['com.openai']?.interface) === JSON.stringify(codex.interface), 'OpenAI interface metadata differs');
assert(catalog.name === marketplace.name, 'Marketplace names differ');
assert(catalog.plugins?.length === 1, 'Expected one OpenAI marketplace entry');
const entryOpenAI = catalog.plugins[0];
assert(entryOpenAI.name === plugin.name, 'OpenAI catalog plugin name differs');
assert(entryOpenAI.source?.source === 'local' && entryOpenAI.source.path === './', 'OpenAI catalog must resolve repository root');
assert(entryOpenAI.policy?.installation === 'AVAILABLE' && entryOpenAI.policy.authentication === 'ON_INSTALL', 'Unexpected OpenAI install policy');
assert(entryOpenAI.category === 'Productivity', 'Missing marketplace category');
for (const path of ['skills/slack-desktop/SKILL.md', 'skills/slack-desktop/scripts/slack.mjs', codex.interface.composerIcon, codex.interface.logo]) {
  assert(typeof path === 'string' && !path.includes('..') && !path.startsWith('/'), `Invalid bundled path: ${path}`);
  assert(await Bun.file(new URL(`../${path}`, import.meta.url)).exists(), `Missing bundled file: ${path}`);
}
console.log('✔ Portable, Codex and ChatGPT packaging checks passed');
