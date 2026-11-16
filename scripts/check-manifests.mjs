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
