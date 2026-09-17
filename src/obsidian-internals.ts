import { App } from "obsidian";

// Obsidian's plugin manager and command registry are not part of the public
// API. These wrappers keep the unsafe casts in one place so the rest of the
// codebase can treat them as ordinary typed calls, and so a future Obsidian
// version that moves or renames them breaks here rather than in six handlers.

export interface PluginInfo {
	id: string;
	name: string;
	enabled: boolean;
	version: string;
}

export interface CommandInfo {
	id: string;
	name: string;
}

interface InternalPluginManager {
	manifests: Record<string, { name?: string; version?: string }>;
	enabledPlugins: Set<string>;
	enablePluginAndSave(id: string): Promise<void>;
	disablePluginAndSave(id: string): Promise<void>;
}

interface InternalCommandRegistry {
	commands: Record<string, CommandInfo>;
	listCommands?(): CommandInfo[];
	executeCommandById(id: string): boolean;
}

export function getInternalPlugins(app: App): InternalPluginManager | null {
	const plugins = (app as unknown as { plugins?: InternalPluginManager }).plugins;
	return plugins ?? null;
}

export function getInternalCommands(app: App): InternalCommandRegistry | null {
	const commands = (app as unknown as { commands?: InternalCommandRegistry }).commands;
	return commands ?? null;
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

export function listCommands(app: App): CommandInfo[] {
	const commands = getInternalCommands(app);
	if (!commands) return [];

	// listCommands() exists in current builds; fall back to the raw map so an
	// older or newer Obsidian that drops it still returns something usable.
	const list =
		typeof commands.listCommands === "function"
			? commands.listCommands()
			: Object.values(commands.commands);

	return list
		.map((c) => ({ id: c.id, name: c.name }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

// Heuristic guard for run_command. Matching on id and display name catches the
// common cases without maintaining a blocklist of every plugin's commands; the
// cost of a false positive is one extra confirm:true, so this errs broad.
const DESTRUCTIVE_PATTERNS = [
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

export function isDestructiveCommand(cmd: CommandInfo): boolean {
	return DESTRUCTIVE_PATTERNS.some((re) => re.test(cmd.id) || re.test(cmd.name));
}
