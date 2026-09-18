// Thin typed wrappers over Obsidian's internal (undocumented) app.plugins and
// app.commands APIs. These are not in obsidian.d.ts but have been stable for
// years; the existing Templater integration already reaches them via
// (app as any).plugins. Centralizing the casts here keeps the rest of the
// codebase honest about types.

import { App, PluginManifest } from "obsidian";

interface InternalPlugins {
	manifests: Record<string, PluginManifest>;
	enabledPlugins: Set<string>;
	getPlugin(id: string): unknown;
	enablePlugin(id: string): Promise<void>;
	disablePlugin(id: string): Promise<void>;
	enablePluginAndSave(id: string): Promise<void>;
	disablePluginAndSave(id: string): Promise<void>;
}

interface ObsidianCommand {
	id: string;
	name: string;
}

interface InternalCommands {
	commands: Record<string, ObsidianCommand>;
	executeCommandById(id: string): boolean;
	listCommands(): ObsidianCommand[];
}

export function getInternalPlugins(app: App): InternalPlugins | null {
	const plugins = (app as unknown as { plugins?: InternalPlugins }).plugins;
	return plugins ?? null;
}

export function getInternalCommands(app: App): InternalCommands | null {
	const commands = (app as unknown as { commands?: InternalCommands }).commands;
	return commands ?? null;
}

export interface PluginInfo {
	id: string;
	name: string;
	enabled: boolean;
	version: string;
}

export function listPlugins(app: App): PluginInfo[] {
	const plugins = getInternalPlugins(app);
	if (!plugins) return [];
	const out: PluginInfo[] = [];
	for (const id of Object.keys(plugins.manifests)) {
		const manifest = plugins.manifests[id];
		out.push({
			id,
			name: manifest?.name ?? id,
			enabled: plugins.enabledPlugins.has(id),
			version: manifest?.version ?? "",
		});
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

export function listCommands(app: App): ObsidianCommand[] {
	const commands = getInternalCommands(app);
	if (!commands) return [];
	// listCommands() exists on recent versions; fall back to the commands map.
	const list = typeof commands.listCommands === "function"
		? commands.listCommands()
		: Object.values(commands.commands);
	return list
		.map((c) => ({ id: c.id, name: c.name }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

// Heuristic denylist for commands whose ids/names suggest an irreversible or
// disruptive effect. Obsidian attaches no "destructive" metadata, so this is a
// best-effort guard, not a guarantee. Matched case-insensitively against both
// the command id and its display name.
const DESTRUCTIVE_PATTERNS: RegExp[] = [
	/\bdelete\b/i,
	/\bremove\b/i,
	/\btrash\b/i,
	/\bempty\b/i,
	/\bclear\b/i,
	/\bpurge\b/i,
	/\bwipe\b/i,
	/\bdestroy\b/i,
	/\breset\b/i,
	/\buninstall\b/i,
	/\boverwrite\b/i,
];

export function isDestructiveCommand(cmd: { id: string; name: string }): boolean {
	return DESTRUCTIVE_PATTERNS.some(
		(re) => re.test(cmd.id) || re.test(cmd.name)
	);
}
