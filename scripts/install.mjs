#!/usr/bin/env node
// Copy built plugin files (main.js, manifest.json) into one or more
// Obsidian vault plugin folders listed in install-targets.json.
//
// install-targets.json shape:
//   { "targets": ["/path/to/VaultA/.obsidian/plugins/obsidian-vault-mcp", ...] }

import { readFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const configPath = join(root, "install-targets.json");
if (!existsSync(configPath)) {
	console.error(
		`install-targets.json not found at ${configPath}\n` +
		`Copy install-targets.example.json to install-targets.json and edit it.`
	);
	process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
const targets = config.targets || [];
if (targets.length === 0) {
	console.error("install-targets.json has no targets.");
	process.exit(1);
}

const sources = [
	{ from: join(root, "dist", "main.js"), name: "main.js" },
	{ from: join(root, "manifest.json"), name: "manifest.json" },
];

for (const { from } of sources) {
	if (!existsSync(from)) {
		console.error(`Missing build artifact: ${from}\nRun 'npm run build' first.`);
		process.exit(1);
	}
}

for (const target of targets) {
	if (!existsSync(target)) mkdirSync(target, { recursive: true });
	for (const { from, name } of sources) {
		copyFileSync(from, join(target, name));
	}
	console.log(`installed → ${target}`);
}
