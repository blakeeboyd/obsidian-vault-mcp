import { App, TFile, TFolder, getAllTags, prepareSimpleSearch } from "obsidian";
import { ToolDefinition, ToolResult, ToolToggles } from "./types";
import { SemanticIndex } from "./semantic";
import { ConsoleBuffer, ConsoleLevel } from "./console-buffer";
import {
	getInternalCommands,
	getInternalPlugins,
	isDestructiveCommand,
	listCommands,
	listPlugins,
} from "./obsidian-internals";

const SELF_PLUGIN_ID = "obsidian-vault-mcp";

export interface ToolContext {
	app: App;
	excludedPaths: string[];
	semanticIndex: SemanticIndex | null;
	semanticEnabled: boolean;
	consoleBuffer: ConsoleBuffer;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "rename_file",
		description:
			"Rename or move a file or folder in the vault. Obsidian automatically updates all internal links. To move a file, provide a new_path in a different directory.",
		inputSchema: {
			type: "object",
			properties: {
				old_path: {
					type: "string",
					description: "Current path relative to vault root",
				},
				new_path: {
					type: "string",
					description: "New path relative to vault root",
				},
			},
			required: ["old_path", "new_path"],
		},
	},
	{
		name: "create_folder",
		description:
			"Create a new folder in the vault. Creates parent directories as needed.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Folder path relative to vault root",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "delete_file",
		description:
			"Delete a file or folder, respecting the user's Obsidian trash preferences.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path relative to vault root",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "list_files",
		description:
			"List files in the vault, optionally filtered by path prefix.",
		inputSchema: {
			type: "object",
			properties: {
				prefix: {
					type: "string",
					description:
						"Optional path prefix to filter results (e.g., '00_sources/')",
				},
			},
		},
	},
	{
		name: "read_file",
		description: "Read the contents of a file in the vault.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path relative to vault root",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "write_file",
		description:
			"Write or overwrite a file in the vault. Creates the file if it does not exist.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path relative to vault root",
				},
				content: {
					type: "string",
					description: "File content to write",
				},
			},
			required: ["path", "content"],
		},
	},
	{
		name: "append_to_file",
		description:
			"Append text to a file using vault.process (transactional read-modify-write). Unlike write_file (a raw overwrite), this routes through the same edit path that Relay's shared-folder sync observes, so appends to a synced file propagate to other vaults. Use for chat/collab files under a Relay shared folder. Creates the file if it does not exist.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path relative to vault root",
				},
				text: {
					type: "string",
					description:
						"Text to append. A trailing newline is added if the file does not already end with one.",
				},
			},
			required: ["path", "text"],
		},
	},
	{
		name: "find_backlinks",
		description:
			"Find all files that contain links pointing to a given file. Returns the list of source file paths.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"File path relative to vault root to find backlinks for",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "search_vault",
		description:
			"Search for text across all files in the vault. Returns matching file paths with the lines that matched.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Text to search for",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "query_frontmatter",
		description:
			"Find files where a frontmatter field matches a given value. Supports string, number, and boolean values. For array fields (like tags), matches if the array contains the value.",
		inputSchema: {
			type: "object",
			properties: {
				field: {
					type: "string",
					description:
						"Frontmatter field name to query (e.g., 'task_status', 'parent')",
				},
				value: {
					type: "string",
					description:
						"Value to match against. For arrays, matches if the array contains this value.",
				},
			},
			required: ["field", "value"],
		},
	},
	{
		name: "find_broken_links",
		description:
			"Find all wikilinks in the vault that point to files that do not exist. Optionally filter to a specific file.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"Optional file path to check. If omitted, scans the entire vault.",
				},
			},
		},
	},
	{
		name: "query_by_tag",
		description:
			"Find all files that contain a given tag, whether in frontmatter or inline in the content.",
		inputSchema: {
			type: "object",
			properties: {
				tag: {
					type: "string",
					description:
						"Tag to search for (with or without # prefix, e.g., 'research' or '#research')",
				},
			},
			required: ["tag"],
		},
	},
	{
		name: "update_frontmatter",
		description:
			"Set or remove a single frontmatter field without touching the file body. To remove a field, pass '__DELETE__' as the value.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path relative to vault root",
				},
				field: {
					type: "string",
					description: "Frontmatter field name to set or remove",
				},
				value: {
					type: "string",
					description:
						"Value to set. Use '__DELETE__' to remove the field. JSON strings are parsed (e.g., '[\"a\", \"b\"]' becomes an array).",
				},
			},
			required: ["path", "field", "value"],
		},
	},
	{
		name: "search_replace",
		description:
			"Find and replace text across one or multiple files. Supports literal and regex patterns. Use dry_run to preview changes before applying.",
		inputSchema: {
			type: "object",
			properties: {
				pattern: {
					type: "string",
					description: "Text or regex pattern to search for",
				},
				replacement: {
					type: "string",
					description: "Replacement text (supports $1, $2, etc. for regex capture groups)",
				},
				paths: {
					type: "array",
					items: { type: "string" },
					description:
						"Optional array of specific file paths to search in",
				},
				glob: {
					type: "string",
					description:
						"Optional glob pattern to filter files (e.g., '10-19_Knowledge/11 Zettelkasten/*.md')",
				},
				regex: {
					type: "boolean",
					description: "Treat pattern as a regular expression (default: false)",
				},
				dry_run: {
					type: "boolean",
					description: "Preview matches without making changes (default: false)",
				},
			},
			required: ["pattern", "replacement"],
		},
	},
	{
		name: "patch_content",
		description:
			"Insert, append, or replace content at a specific location in a file, identified by a heading or marker string.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path relative to vault root",
				},
				operation: {
					type: "string",
					enum: ["append_after", "prepend_before", "replace_section"],
					description:
						"How to apply the edit: append_after inserts content after the marker line, prepend_before inserts before the marker line, replace_section replaces from the marker to the next heading of equal or higher level",
				},
				marker: {
					type: "string",
					description:
						"Text to locate in the file — typically a heading (e.g., '## Connections') or any unique line",
				},
				content: {
					type: "string",
					description: "Content to insert or replace with",
				},
			},
			required: ["path", "operation", "marker", "content"],
		},
	},
	{
		name: "semantic_search",
		description:
			"Find notes semantically related to a natural language query. Uses local embeddings (all-MiniLM-L6-v2) indexed over the vault. Must be enabled and indexed in plugin settings first. Returns file paths ranked by cosine similarity with short snippets.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Natural language search query",
				},
				limit: {
					type: "number",
					description: "Maximum number of results to return (default: 10)",
				},
				filter: {
					type: "string",
					description:
						"Optional path prefix to narrow search scope (e.g., '10-19_Knowledge/11 Zettelkasten/')",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "find_related_notes",
		description:
			"Note-driven semantic discovery: given a note's path, return other notes ranked by mean-pooled cosine similarity. Useful for finding wikilink candidates, surfacing forgotten neighbors, or cross-pollinating between Zettelkasten / synthesis branches. Mean pooling implicitly favors atomic notes; long multi-topic notes (lit notes, source files) will give muddier results. Requires semantic search to be enabled and indexed. Optionally returns chunk-pair evidence showing which passages drove each match.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"Path of the source note relative to vault root. Must already be in the semantic index.",
				},
				limit: {
					type: "number",
					description: "Maximum number of results to return (default: 10)",
				},
				filter: {
					type: "string",
					description:
						"Optional path prefix to include (e.g., '10-19_Knowledge/11 Zettelkasten/' to find related zettels only)",
				},
				exclude_prefix: {
					type: "array",
					items: { type: "string" },
					description:
						"Optional list of path prefixes to exclude from results (e.g., to skip source/lit folders when looking for synthesis neighbors)",
				},
				include_evidence: {
					type: "boolean",
					description:
						"If true, include the most-similar chunk text from both the source and each candidate so you can see why two notes connect (default: false)",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "list_templates",
		description:
			"List available Templater templates. Requires the Templater plugin to be installed.",
		inputSchema: {
			type: "object",
			properties: {},
		},
	},
	{
		name: "open_file",
		description:
			"Open a file in the Obsidian editor. Useful for navigating to a file after creating or modifying it.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path relative to vault root",
				},
				new_leaf: {
					type: "boolean",
					description: "Open in a new tab instead of replacing the current one (default: false)",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "create_from_template",
		description:
			"Create a new file using a Templater template. The template's <%* %> blocks will be executed. Note: templates that require user prompts or editor selection will not work via MCP.",
		inputSchema: {
			type: "object",
			properties: {
				template_path: {
					type: "string",
					description: "Path to the template file relative to vault root",
				},
				target_path: {
					type: "string",
					description: "Path for the new file to create",
				},
				open: {
					type: "boolean",
					description: "Open the file in Obsidian after creation (default: false)",
				},
			},
			required: ["template_path", "target_path"],
		},
	},
	{
		name: "get_vault_info",
		description:
			"Return the name and absolute path of the Obsidian vault this MCP server is serving. Useful for confirming which vault a connection is talking to when running the plugin in multiple vaults at once.",
		inputSchema: {
			type: "object",
			properties: {},
		},
	},
	{
		name: "read_console",
		description:
			"Read recent entries from the Obsidian developer console. The plugin captures all console.log/info/warn/error/debug output (from this plugin, other plugins, and Obsidian core) plus uncaught exceptions and unhandled promise rejections, starting from when the plugin loaded. Useful for debugging plugin errors without opening DevTools. Returns entries oldest-first with timestamps and levels.",
		inputSchema: {
			type: "object",
			properties: {
				levels: {
					type: "array",
					items: {
						type: "string",
						enum: ["log", "info", "warn", "error", "debug"],
					},
					description:
						"Optional list of levels to include (e.g. ['error', 'warn']). Omit to include all levels.",
				},
				filter: {
					type: "string",
					description:
						"Optional case-insensitive substring; only entries whose message contains it are returned.",
				},
				limit: {
					type: "number",
					description:
						"Maximum number of most-recent entries to return (default: 100).",
				},
			},
		},
	},
	{
		name: "clear_console",
		description:
			"Clear the plugin's captured console buffer. Use before reproducing a bug so a subsequent read_console returns only the new output. Does not affect the actual DevTools console.",
		inputSchema: {
			type: "object",
			properties: {},
		},
	},
	{
		name: "list_plugins",
		description:
			"List installed community plugins with their id, display name, version, and whether they are currently enabled. Use the id with set_plugin_enabled.",
		inputSchema: {
			type: "object",
			properties: {
				enabled_only: {
					type: "boolean",
					description:
						"If true, return only currently-enabled plugins (default: false).",
				},
			},
		},
	},
	{
		name: "set_plugin_enabled",
		description:
			"Enable or disable a community plugin by id, persisting the change to Obsidian config (survives restart). Combine with read_console to disable then re-enable a plugin and capture its startup output. Cannot toggle this plugin (obsidian-vault-mcp) itself.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Plugin id (from list_plugins, e.g. 'dataview').",
				},
				enabled: {
					type: "boolean",
					description: "true to enable, false to disable.",
				},
				delay_ms: {
					type: "number",
					description:
						"Wait this many milliseconds after the toggle before returning, so a plugin's async load (and any console output it emits during load) finishes before a follow-up read_console. Capped at 10000. Default 0.",
				},
			},
			required: ["id", "enabled"],
		},
	},
	{
		name: "list_commands",
		description:
			"List all commands registered in Obsidian's command palette (Cmd+P), returning each command's id and display name. Use the id with run_command.",
		inputSchema: {
			type: "object",
			properties: {
				filter: {
					type: "string",
					description:
						"Optional case-insensitive substring to match against command id or name.",
				},
			},
		},
	},
	{
		name: "run_command",
		description:
			"Execute an Obsidian command by id, as if invoked from the command palette (Cmd+P). Commands whose id or name suggests a destructive effect (delete, trash, clear, reset, etc.) are refused unless confirm:true is passed. Some commands require an active editor or specific context and may silently no-op.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Command id (from list_commands, e.g. 'editor:toggle-bold').",
				},
				confirm: {
					type: "boolean",
					description:
						"Required (true) to run a command flagged as potentially destructive. Ignored for other commands.",
				},
			},
			required: ["id"],
		},
	},
];

export interface ToolLabel {
	name: string;
	desc: string;
}

export interface ToolCategory {
	heading: string;
	description: string;
	tools: Record<string, ToolLabel>;
}

export const TOOL_CATEGORIES: ToolCategory[] = [
	{
		heading: "File Operations",
		description: "Tools for reading, writing, and managing vault files and folders.",
		tools: {
			rename_file: {
				name: "Rename / Move",
				desc: "Rename or move files and folders with automatic link updating",
			},
			create_folder: {
				name: "Create Folder",
				desc: "Create new folders in the vault",
			},
			delete_file: {
				name: "Delete",
				desc: "Delete files and folders (respects your trash settings)",
			},
			list_files: {
				name: "List Files",
				desc: "List vault files with optional path prefix filter",
			},
			read_file: {
				name: "Read File",
				desc: "Read file contents from the vault",
			},
			write_file: {
				name: "Write File",
				desc: "Write or create files in the vault",
			},
		},
	},
	{
		heading: "Search & Query",
		description: "Tools for searching content, querying metadata, and finding links.",
		tools: {
			find_backlinks: {
				name: "Find Backlinks",
				desc: "Find all files that link to a given file",
			},
			search_vault: {
				name: "Search Vault",
				desc: "Full-text search across all vault files",
			},
			query_frontmatter: {
				name: "Query Frontmatter",
				desc: "Find files by frontmatter field values",
			},
			find_broken_links: {
				name: "Find Broken Links",
				desc: "Find wikilinks pointing to non-existent files",
			},
			query_by_tag: {
				name: "Query by Tag",
				desc: "Find files with a specific tag",
			},
			// semantic_search is gated by the Semantic Search section's
			// "Enable semantic search" toggle, not a separate per-tool toggle.
		},
	},
	{
		heading: "Quality of Life",
		description: "Tools for batch operations and targeted edits.",
		tools: {
			update_frontmatter: {
				name: "Update Frontmatter",
				desc: "Set or remove a frontmatter field",
			},
			search_replace: {
				name: "Search & Replace",
				desc: "Find and replace text across files",
			},
			patch_content: {
				name: "Patch Content",
				desc: "Insert or replace content at a specific location",
			},
			append_to_file: {
				name: "Append to File",
				desc: "Append text transactionally, so Relay-synced files propagate",
			},
			open_file: {
				name: "Open File",
				desc: "Open a file in the Obsidian editor",
			},
			get_vault_info: {
				name: "Vault Info",
				desc: "Expose vault name and path (useful for multi-vault setups)",
			},
		},
	},
	{
		heading: "Templater",
		description: "Requires the Templater plugin. Safe to leave on — tools return a clear error if Templater is not installed.",
		tools: {
			list_templates: {
				name: "List Templates",
				desc: "Show available Templater templates",
			},
			create_from_template: {
				name: "Create from Template",
				desc: "Create a file using a Templater template",
			},
		},
	},
	{
		heading: "Diagnostics",
		description:
			"Surface the Obsidian developer console to the MCP client. The plugin buffers console output from the moment it loads; these tools read and clear that buffer.",
		tools: {
			read_console: {
				name: "Read Console",
				desc: "Read recent captured console output (logs, warnings, errors)",
			},
			clear_console: {
				name: "Clear Console Buffer",
				desc: "Empty the captured console buffer",
			},
		},
	},
	{
		heading: "App Control",
		description:
			"Let the MCP client manage plugins and run command-palette commands. Useful for a disable → re-enable → read_console debugging loop. Destructive-looking commands require an explicit confirm flag.",
		tools: {
			list_plugins: {
				name: "List Plugins",
				desc: "List installed plugins and their enabled state",
			},
			set_plugin_enabled: {
				name: "Enable / Disable Plugin",
				desc: "Toggle a community plugin on or off (persisted)",
			},
			list_commands: {
				name: "List Commands",
				desc: "List command-palette commands and their ids",
			},
			run_command: {
				name: "Run Command",
				desc: "Execute a command-palette command by id",
			},
		},
	},
];

export const TOOL_LABELS: Record<string, ToolLabel> = Object.assign(
	{},
	...TOOL_CATEGORIES.map((cat) => cat.tools)
);

export function getEnabledTools(toggles: ToolToggles): ToolDefinition[] {
	return TOOL_DEFINITIONS.filter(
		(t) => toggles[t.name as keyof ToolToggles] !== false
	);
}

export function isPathAllowed(
	path: string,
	excludedPaths: string[]
): boolean {
	return !excludedPaths.some(
		(excluded) => path === excluded || path.startsWith(excluded + "/")
	);
}

function normalizePath(path: string): string | null {
	const cleaned = path.startsWith("/") ? path.slice(1) : path;
	if (cleaned.includes("..")) return null;
	return cleaned;
}

function textResult(text: string): ToolResult {
	return { content: [{ type: "text", text }] };
}

function errorResult(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

async function ensureParentFolder(app: App, filePath: string): Promise<void> {
	const lastSlash = filePath.lastIndexOf("/");
	if (lastSlash <= 0) return;

	const parentPath = filePath.substring(0, lastSlash);
	const existing = app.vault.getAbstractFileByPath(parentPath);
	if (existing) return;

	await app.vault.createFolder(parentPath);
}

async function handleRenameFile(
	app: App,
	args: Record<string, unknown>
): Promise<ToolResult> {
	const oldPath = normalizePath(String(args.old_path || ""));
	const newPath = normalizePath(String(args.new_path || ""));
	if (!oldPath) return errorResult("Invalid old_path");
	if (!newPath) return errorResult("Invalid new_path");

	const file = app.vault.getAbstractFileByPath(oldPath);
	if (!file) return errorResult(`File not found: ${oldPath}`);

	await ensureParentFolder(app, newPath);
	await app.fileManager.renameFile(file, newPath);

	return textResult(
		`Renamed '${oldPath}' to '${newPath}'. All internal links updated.`
	);
}

async function handleCreateFolder(
	app: App,
	args: Record<string, unknown>
): Promise<ToolResult> {
	const path = normalizePath(String(args.path || ""));
	if (!path) return errorResult("Invalid path");

	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFolder) {
		return textResult(`Folder already exists: ${path}`);
	}
	if (existing) {
		return errorResult(`A file already exists at: ${path}`);
	}

	await app.vault.createFolder(path);
	return textResult(`Created folder: ${path}`);
}

async function handleDeleteFile(
	app: App,
	args: Record<string, unknown>
): Promise<ToolResult> {
	const path = normalizePath(String(args.path || ""));
	if (!path) return errorResult("Invalid path");

	const file = app.vault.getAbstractFileByPath(path);
	if (!file) return errorResult(`File not found: ${path}`);

	await app.fileManager.trashFile(file);
	return textResult(`Deleted: ${path}`);
}

async function handleListFiles(
	app: App,
	args: Record<string, unknown>,
	excludedPaths: string[] = []
): Promise<ToolResult> {
	const prefix = args.prefix ? String(args.prefix) : undefined;
	const allFiles = app.vault.getFiles();
	let paths = allFiles.map((f) => f.path).sort();

	if (prefix) {
		paths = paths.filter((p) => p.startsWith(prefix));
	}

	if (excludedPaths.length > 0) {
		paths = paths.filter((p) => isPathAllowed(p, excludedPaths));
	}

	return textResult(paths.join("\n") || "(no files found)");
}

async function handleReadFile(
	app: App,
	args: Record<string, unknown>
): Promise<ToolResult> {
	const path = normalizePath(String(args.path || ""));
	if (!path) return errorResult("Invalid path");

	const file = app.vault.getAbstractFileByPath(path);
	if (!file) return errorResult(`File not found: ${path}`);
	if (!(file instanceof TFile))
		return errorResult(`Not a file: ${path}`);

	const content = await app.vault.adapter.read(path);
	return textResult(content);
}

async function handleWriteFile(
	app: App,
	args: Record<string, unknown>
): Promise<ToolResult> {
	const path = normalizePath(String(args.path || ""));
	const content = String(args.content ?? "");
	if (!path) return errorResult("Invalid path");

	await ensureParentFolder(app, path);

	const existing = app.vault.getAbstractFileByPath(path);
	if (existing && existing instanceof TFile) {
		// vault.modify (vs adapter.write) fires the "modify" vault event that
		// other plugins subscribe to, including this plugin's auto-reindex.
		await app.vault.modify(existing, content);
		return textResult(`Updated file: ${path}`);
	} else if (existing) {
		return errorResult(`A folder exists at: ${path}`);
	}

	await app.vault.create(path, content);
	return textResult(`Created file: ${path}`);
}

async function handleAppendToFile(
	app: App,
	args: Record<string, unknown>
): Promise<ToolResult> {
	const path = normalizePath(String(args.path || ""));
	const text = String(args.text ?? "");
	if (!path) return errorResult("Invalid path");

	await ensureParentFolder(app, path);

	const existing = app.vault.getAbstractFileByPath(path);
	if (existing && !(existing instanceof TFile)) {
		return errorResult(`A folder exists at: ${path}`);
	}
	if (!existing) {
		await app.vault.create(path, "");
	}

	const file = app.vault.getAbstractFileByPath(path) as TFile;
	// vault.process is the transactional read-modify-write path; Relay observes
	// it, so appends to a shared-folder file propagate to other vaults.
	await app.vault.process(file, (data) => {
		const sep = data.length === 0 || data.endsWith("\n") ? "" : "\n";
		const tail = text.endsWith("\n") ? "" : "\n";
		return data + sep + text + tail;
	});

	return textResult(`Appended to file: ${path}`);
}

async function handleFindBacklinks(
	app: App,
	args: Record<string, unknown>,
	excludedPaths: string[]
): Promise<ToolResult> {
	const path = normalizePath(String(args.path || ""));
	if (!path) return errorResult("Invalid path");

	const file = app.vault.getAbstractFileByPath(path);
	if (!file) return errorResult(`File not found: ${path}`);

	const backlinks: string[] = [];
	const resolved = app.metadataCache.resolvedLinks;

	for (const [sourcePath, destinations] of Object.entries(resolved)) {
		if (destinations[path] !== undefined) {
			if (isPathAllowed(sourcePath, excludedPaths)) {
				backlinks.push(sourcePath);
			}
		}
	}

	backlinks.sort();
	if (backlinks.length === 0) {
		return textResult(`No backlinks found for: ${path}`);
	}
	return textResult(backlinks.join("\n"));
}

async function handleSearchVault(
	app: App,
	args: Record<string, unknown>,
	excludedPaths: string[]
): Promise<ToolResult> {
	const query = String(args.query || "").trim();
	if (!query) return errorResult("Query is required");

	const searchFn = prepareSimpleSearch(query);
	const files = app.vault.getMarkdownFiles();
	const matches: string[] = [];

	for (const file of files) {
		if (!isPathAllowed(file.path, excludedPaths)) continue;

		const content = await app.vault.cachedRead(file);
		const result = searchFn(content);

		if (result) {
			const lines = content.split("\n");
			const matchingLines: string[] = [];
			for (const [start, end] of result.matches) {
				let pos = 0;
				for (let i = 0; i < lines.length; i++) {
					const lineEnd = pos + lines[i].length;
					if (start >= pos && start <= lineEnd) {
						const lineNum = i + 1;
						matchingLines.push(`  ${lineNum}: ${lines[i].trim()}`);
						break;
					}
					pos = lineEnd + 1;
				}
			}
			const uniqueLines = [...new Set(matchingLines)].slice(0, 5);
			matches.push(`${file.path}\n${uniqueLines.join("\n")}`);
		}

		if (matches.length >= 50) break;
	}

	if (matches.length === 0) {
		return textResult(`No results found for: ${query}`);
	}
	return textResult(matches.join("\n\n"));
}

async function handleQueryFrontmatter(
	app: App,
	args: Record<string, unknown>,
	excludedPaths: string[]
): Promise<ToolResult> {
	const field = String(args.field || "").trim();
	const value = String(args.value || "").trim();
	if (!field) return errorResult("Field is required");
	if (!value) return errorResult("Value is required");

	const files = app.vault.getMarkdownFiles();
	const matches: string[] = [];

	for (const file of files) {
		if (!isPathAllowed(file.path, excludedPaths)) continue;

		const cache = app.metadataCache.getFileCache(file);
		if (!cache?.frontmatter) continue;

		const fieldValue = cache.frontmatter[field];
		if (fieldValue === undefined) continue;

		if (Array.isArray(fieldValue)) {
			if (fieldValue.some((v) => String(v) === value)) {
				matches.push(`${file.path}  (${field}: [${fieldValue.join(", ")}])`);
			}
		} else if (String(fieldValue) === value) {
			matches.push(`${file.path}  (${field}: ${fieldValue})`);
		}
	}

	matches.sort();
	if (matches.length === 0) {
		return textResult(`No files found with ${field} = ${value}`);
	}
	return textResult(matches.join("\n"));
}

async function handleFindBrokenLinks(
	app: App,
	args: Record<string, unknown>,
	excludedPaths: string[]
): Promise<ToolResult> {
	const filterPath = args.path ? normalizePath(String(args.path)) : null;
	const unresolved = app.metadataCache.unresolvedLinks;
	const results: string[] = [];

	for (const [sourcePath, destinations] of Object.entries(unresolved)) {
		if (!isPathAllowed(sourcePath, excludedPaths)) continue;
		if (filterPath && sourcePath !== filterPath) continue;

		const brokenLinks = Object.keys(destinations);
		if (brokenLinks.length > 0) {
			results.push(
				`${sourcePath}\n${brokenLinks.map((l) => `  -> ${l}`).join("\n")}`
			);
		}
	}

	results.sort();
	if (results.length === 0) {
		const scope = filterPath ? filterPath : "the vault";
		return textResult(`No broken links found in ${scope}`);
	}
	return textResult(results.join("\n\n"));
}

async function handleQueryByTag(
	app: App,
	args: Record<string, unknown>,
	excludedPaths: string[]
): Promise<ToolResult> {
	let tag = String(args.tag || "").trim();
	if (!tag) return errorResult("Tag is required");

	if (!tag.startsWith("#")) tag = `#${tag}`;

	const files = app.vault.getMarkdownFiles();
	const matches: string[] = [];

	for (const file of files) {
		if (!isPathAllowed(file.path, excludedPaths)) continue;

		const cache = app.metadataCache.getFileCache(file);
		if (!cache) continue;

		const fileTags = getAllTags(cache);
		if (fileTags && fileTags.includes(tag)) {
			matches.push(file.path);
		}
	}

	matches.sort();
	if (matches.length === 0) {
		return textResult(`No files found with tag: ${tag}`);
	}
	return textResult(matches.join("\n"));
}

async function handleUpdateFrontmatter(
	app: App,
	args: Record<string, unknown>
): Promise<ToolResult> {
	const path = normalizePath(String(args.path || ""));
	if (!path) return errorResult("Invalid path");

	const field = String(args.field || "").trim();
	if (!field) return errorResult("Field is required");

	const rawValue = String(args.value ?? "");
	const isDelete = rawValue === "__DELETE__";

	const file = app.vault.getAbstractFileByPath(path);
	if (!file) return errorResult(`File not found: ${path}`);
	if (!(file instanceof TFile)) return errorResult(`Not a file: ${path}`);

	let parsedValue: unknown = rawValue;
	if (!isDelete) {
		try {
			parsedValue = JSON.parse(rawValue);
		} catch {
			// Keep as string
		}
	}

	await app.fileManager.processFrontMatter(file, (frontmatter) => {
		if (isDelete) {
			delete frontmatter[field];
		} else {
			frontmatter[field] = parsedValue;
		}
	});

	if (isDelete) {
		return textResult(`Removed field '${field}' from ${path}`);
	}
	return textResult(`Set ${field} = ${rawValue} in ${path}`);
}

function matchesGlob(filePath: string, glob: string): boolean {
	let pattern = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "§§")
		.replace(/\*/g, "[^/]*")
		.replace(/§§/g, ".*")
		.replace(/\?/g, "[^/]");
	return new RegExp(`^${pattern}$`).test(filePath);
}

async function handleSearchReplace(
	app: App,
	args: Record<string, unknown>,
	excludedPaths: string[]
): Promise<ToolResult> {
	const pattern = String(args.pattern || "");
	if (!pattern) return errorResult("Pattern is required");

	const replacement = String(args.replacement ?? "");
	const useRegex = Boolean(args.regex);
	const dryRun = Boolean(args.dry_run);
	const paths = args.paths as string[] | undefined;
	const glob = args.glob ? String(args.glob) : undefined;

	let searchRegex: RegExp;
	try {
		if (useRegex) {
			searchRegex = new RegExp(pattern, "g");
		} else {
			searchRegex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return errorResult(`Invalid regex: ${msg}`);
	}

	let files: TFile[];
	if (paths && paths.length > 0) {
		files = [];
		for (const p of paths) {
			const normalized = normalizePath(p);
			if (!normalized) continue;
			const f = app.vault.getAbstractFileByPath(normalized);
			if (f instanceof TFile) files.push(f);
		}
	} else {
		files = app.vault.getMarkdownFiles();
	}

	if (glob) {
		files = files.filter((f) => matchesGlob(f.path, glob));
	}

	files = files.filter((f) => isPathAllowed(f.path, excludedPaths));
	files.sort((a, b) => a.path.localeCompare(b.path));

	const results: string[] = [];
	let totalReplacements = 0;

	for (const file of files) {
		const content = await app.vault.read(file);
		const matches = content.match(searchRegex);
		if (!matches || matches.length === 0) continue;

		const count = matches.length;
		totalReplacements += count;

		if (dryRun) {
			results.push(`${file.path}: ${count} match${count === 1 ? "" : "es"}`);
		} else {
			const newContent = content.replace(searchRegex, replacement);
			await app.vault.modify(file, newContent);
			results.push(`${file.path}: ${count} replacement${count === 1 ? "" : "s"}`);
		}

		searchRegex.lastIndex = 0;
	}

	if (results.length === 0) {
		return textResult(`No matches found for: ${pattern}`);
	}

	const header = dryRun
		? `Dry run — ${totalReplacements} match${totalReplacements === 1 ? "" : "es"} in ${results.length} file${results.length === 1 ? "" : "s"}:`
		: `Replaced ${totalReplacements} occurrence${totalReplacements === 1 ? "" : "s"} in ${results.length} file${results.length === 1 ? "" : "s"}:`;
	return textResult(`${header}\n${results.join("\n")}`);
}

async function handlePatchContent(
	app: App,
	args: Record<string, unknown>
): Promise<ToolResult> {
	const path = normalizePath(String(args.path || ""));
	if (!path) return errorResult("Invalid path");

	const operation = String(args.operation || "");
	if (!["append_after", "prepend_before", "replace_section"].includes(operation)) {
		return errorResult("Operation must be 'append_after', 'prepend_before', or 'replace_section'");
	}

	const marker = String(args.marker || "");
	if (!marker) return errorResult("Marker is required");

	const content = String(args.content ?? "");

	const file = app.vault.getAbstractFileByPath(path);
	if (!file) return errorResult(`File not found: ${path}`);
	if (!(file instanceof TFile)) return errorResult(`Not a file: ${path}`);

	const fileContent = await app.vault.read(file);
	const lines = fileContent.split("\n");

	const markerIndex = lines.findIndex((line) => line.trim() === marker.trim());
	if (markerIndex === -1) {
		return errorResult(`Marker not found in ${path}: ${marker}`);
	}

	let newLines: string[];

	if (operation === "append_after") {
		newLines = [
			...lines.slice(0, markerIndex + 1),
			content,
			...lines.slice(markerIndex + 1),
		];
	} else if (operation === "prepend_before") {
		newLines = [
			...lines.slice(0, markerIndex),
			content,
			...lines.slice(markerIndex),
		];
	} else {
		const markerLine = lines[markerIndex];
		const headingMatch = markerLine.match(/^(#{1,6})\s/);
		const markerLevel = headingMatch ? headingMatch[1].length : 0;

		let endIndex = lines.length;
		if (markerLevel > 0) {
			for (let i = markerIndex + 1; i < lines.length; i++) {
				const lineHeading = lines[i].match(/^(#{1,6})\s/);
				if (lineHeading && lineHeading[1].length <= markerLevel) {
					endIndex = i;
					break;
				}
			}
		}

		newLines = [
			...lines.slice(0, markerIndex),
			`${markerLine}`,
			content,
			...lines.slice(endIndex),
		];
	}

	await app.vault.modify(file, newLines.join("\n"));
	return textResult(`Patched ${path} at '${marker}' (${operation})`);
}

async function handleSemanticSearch(
	ctx: ToolContext,
	args: Record<string, unknown>
): Promise<ToolResult> {
	if (!ctx.semanticEnabled || !ctx.semanticIndex) {
		return errorResult(
			"Semantic search is disabled. Enable it in Vault MCP settings and run 'Reindex vault' first."
		);
	}

	const query = String(args.query || "").trim();
	if (!query) return errorResult("Query is required");

	const limit = typeof args.limit === "number" ? args.limit : 10;
	const filter = args.filter ? String(args.filter) : undefined;

	try {
		const results = await ctx.semanticIndex.search(query, {
			limit,
			filter,
			excludedPaths: ctx.excludedPaths,
		});

		if (results.length === 0) {
			return textResult(
				`No semantic matches found for: ${query}\n(If you just enabled semantic search, run 'Reindex vault' from the Vault MCP settings.)`
			);
		}

		const formatted = results.map((r) => {
			const score = r.score.toFixed(3);
			return `${r.path}  (${score})\n  ${r.snippet}`;
		});
		return textResult(formatted.join("\n\n"));
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return errorResult(`Semantic search failed: ${msg}`);
	}
}

// Coarse cosine bands. Picked to match how BGE micro v2 cosine
// distributions look in practice: most "related" results sit between
// 0.55 and 0.85, with strong matches above. Bands give the reader a
// label they can grasp without doing arithmetic on the raw score.
function scoreBand(score: number): string {
	if (score >= 0.85) return "strong";
	if (score >= 0.7) return "moderate";
	if (score >= 0.55) return "loose";
	return "weak";
}

async function handleFindRelatedNotes(
	ctx: ToolContext,
	args: Record<string, unknown>
): Promise<ToolResult> {
	if (!ctx.semanticEnabled || !ctx.semanticIndex) {
		return errorResult(
			"Semantic search is disabled. Enable it in Vault MCP settings and run 'Reindex vault' first."
		);
	}

	const path = normalizePath(String(args.path || ""));
	if (!path) return errorResult("path is required");

	const limit = typeof args.limit === "number" ? args.limit : 10;
	const filter = args.filter ? String(args.filter) : undefined;
	const excludePrefix = Array.isArray(args.exclude_prefix)
		? args.exclude_prefix.map((p) => String(p))
		: undefined;
	const includeEvidence = Boolean(args.include_evidence);

	try {
		const results = await ctx.semanticIndex.findRelatedNotes(path, {
			limit,
			filter,
			excludePrefix,
			excludedPaths: ctx.excludedPaths,
			includeEvidence,
		});

		if (results.length === 0) {
			return textResult(`No related notes found for: ${path}`);
		}

		const formatted = results.map((r) => {
			const score = r.score.toFixed(3);
			const band = scoreBand(r.score);
			let block = `${r.path}  (${band} · ${score})`;
			if (r.aliases && r.aliases.length > 0) {
				block += `\n  aliases: ${r.aliases.join(", ")}`;
			}
			// Prefer the authored caption when present; chunk excerpt
			// otherwise. Authored summary tells the reader what the file
			// is about; chunk excerpt only describes one passage.
			const caption = r.summary ?? r.snippet;
			block += `\n  ${caption}`;
			if (r.sharedLinks && r.sharedLinks.length > 0) {
				const refs = r.sharedLinks
					.map((p) => `[[${p.replace(/\.md$/, "")}]]`)
					.join(", ");
				block += `\n  shared links: ${refs}`;
			}
			if (r.sharedTags && r.sharedTags.length > 0) {
				block += `\n  shared tags: ${r.sharedTags.join(", ")}`;
			}
			if (r.directLink) {
				block += `\n  direct link: ${r.directLink}`;
			}
			if (includeEvidence && r.sourceChunkText !== undefined) {
				block += `\n  Source chunk #${r.sourceChunkIndex}: ${r.sourceChunkText}`;
				block += `\n  Match chunk #${r.chunkIndex}: ${r.snippet}`;
			}
			return block;
		});
		return textResult(formatted.join("\n\n"));
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return errorResult(`Find related notes failed: ${msg}`);
	}
}

async function handleListTemplates(
	app: App
): Promise<ToolResult> {
	const templater = (app as any).plugins?.getPlugin?.("templater-obsidian");
	if (!templater) {
		return errorResult(
			"Templater plugin is not installed or enabled. Install it from Obsidian Community Plugins."
		);
	}

	const templateFolder = templater.settings?.templates_folder;
	if (!templateFolder) {
		return errorResult(
			"Templater template folder is not configured. Set it in Templater settings."
		);
	}

	const folder = app.vault.getAbstractFileByPath(templateFolder);
	if (!folder || !(folder instanceof TFolder)) {
		return errorResult(`Template folder not found: ${templateFolder}`);
	}

	const templates: string[] = [];
	for (const child of folder.children) {
		if (child instanceof TFile && child.extension === "md") {
			templates.push(child.path);
		}
	}

	templates.sort();
	if (templates.length === 0) {
		return textResult(`No templates found in ${templateFolder}`);
	}
	return textResult(templates.join("\n"));
}

async function handleOpenFile(
	app: App,
	args: Record<string, unknown>
): Promise<ToolResult> {
	const path = normalizePath(String(args.path || ""));
	if (!path) return errorResult("Invalid path");

	const file = app.vault.getAbstractFileByPath(path);
	if (!file) return errorResult(`File not found: ${path}`);
	if (!(file instanceof TFile)) return errorResult(`Not a file: ${path}`);

	const newLeaf = Boolean(args.new_leaf);
	const leaf = newLeaf ? app.workspace.getLeaf("tab") : app.workspace.getLeaf();
	await leaf.openFile(file);

	return textResult(`Opened ${path} in Obsidian`);
}

async function handleCreateFromTemplate(
	app: App,
	args: Record<string, unknown>
): Promise<ToolResult> {
	const templatePath = normalizePath(String(args.template_path || ""));
	const targetPath = normalizePath(String(args.target_path || ""));
	if (!templatePath) return errorResult("Invalid template_path");
	if (!targetPath) return errorResult("Invalid target_path");

	const shouldOpen = Boolean(args.open);

	const templateFile = app.vault.getAbstractFileByPath(templatePath);
	if (!templateFile || !(templateFile instanceof TFile)) {
		return errorResult(`Template not found: ${templatePath}`);
	}

	const existing = app.vault.getAbstractFileByPath(targetPath);
	if (existing) {
		return errorResult(`File already exists: ${targetPath}`);
	}

	const templateContent = await app.vault.read(templateFile);

	await ensureParentFolder(app, targetPath);
	const newFile = await app.vault.create(targetPath, templateContent);

	const templater = (app as any).plugins?.getPlugin?.("templater-obsidian");
	let processed = false;

	if (templater?.templater) {
		try {
			await templater.templater.overwrite_file_commands(newFile);
			processed = true;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return textResult(
				`Created ${targetPath} but Templater processing failed: ${msg}. File contains raw template content.`
			);
		}
	}

	if (shouldOpen) {
		await app.workspace.getLeaf().openFile(newFile);
	}

	if (processed) {
		return textResult(`Created ${targetPath} from template ${templatePath} (Templater processed)`);
	}
	return textResult(
		`Created ${targetPath} from template ${templatePath} (raw content — Templater not available)`
	);
}

async function handleGetVaultInfo(app: App): Promise<ToolResult> {
	const name = app.vault.getName();
	const adapter = app.vault.adapter as any;
	const basePath = adapter.basePath || adapter.getBasePath?.() || "";
	return textResult(
		JSON.stringify(
			{ name, path: basePath, file_count: app.vault.getFiles().length },
			null,
			2
		)
	);
}

const VALID_CONSOLE_LEVELS: ConsoleLevel[] = ["log", "info", "warn", "error", "debug"];

async function handleReadConsole(
	ctx: ToolContext,
	args: Record<string, unknown>
): Promise<ToolResult> {
	let levels: ConsoleLevel[] | undefined;
	if (Array.isArray(args.levels)) {
		levels = args.levels
			.map((l) => String(l) as ConsoleLevel)
			.filter((l) => VALID_CONSOLE_LEVELS.includes(l));
	}
	const filter = args.filter ? String(args.filter) : undefined;
	const limit = typeof args.limit === "number" ? args.limit : 100;

	const entries = ctx.consoleBuffer.read({ levels, filter, limit });
	if (entries.length === 0) {
		const total = ctx.consoleBuffer.size();
		return textResult(
			total === 0
				? "Console buffer is empty. (Output is captured from when the plugin loaded onward.)"
				: "No console entries match the given filters."
		);
	}

	const lines = entries.map((e) => {
		const time = new Date(e.timestamp).toISOString().slice(11, 23);
		return `[${time}] ${e.level.toUpperCase()}: ${e.message}`;
	});
	const header = `Showing ${entries.length} of ${ctx.consoleBuffer.size()} buffered entries:`;
	return textResult(`${header}\n${lines.join("\n")}`);
}

async function handleClearConsole(ctx: ToolContext): Promise<ToolResult> {
	const cleared = ctx.consoleBuffer.size();
	ctx.consoleBuffer.clear();
	return textResult(`Cleared ${cleared} console entr${cleared === 1 ? "y" : "ies"}.`);
}

async function handleListPlugins(
	app: App,
	args: Record<string, unknown>
): Promise<ToolResult> {
	if (!getInternalPlugins(app)) {
		return errorResult("Plugin manager API is unavailable in this Obsidian version.");
	}

	const enabledOnly = Boolean(args.enabled_only);
	let plugins = listPlugins(app);
	if (enabledOnly) plugins = plugins.filter((p) => p.enabled);

	if (plugins.length === 0) {
		return textResult(enabledOnly ? "No enabled plugins." : "No plugins found.");
	}

	const lines = plugins.map((p) => {
		const state = p.enabled ? "on " : "off";
		const ver = p.version ? ` v${p.version}` : "";
		return `[${state}] ${p.id}  —  ${p.name}${ver}`;
	});
	return textResult(lines.join("\n"));
}

async function handleSetPluginEnabled(
	app: App,
	args: Record<string, unknown>
): Promise<ToolResult> {
	const plugins = getInternalPlugins(app);
	if (!plugins) {
		return errorResult("Plugin manager API is unavailable in this Obsidian version.");
	}

	const id = String(args.id || "").trim();
	if (!id) return errorResult("id is required");
	if (typeof args.enabled !== "boolean") {
		return errorResult("enabled (boolean) is required");
	}
	const enabled = args.enabled;

	if (id === SELF_PLUGIN_ID) {
		return errorResult(
			"Refusing to toggle obsidian-vault-mcp itself — disabling it would kill the MCP server mid-call. Toggle it from Obsidian settings if needed."
		);
	}
	if (!plugins.manifests[id]) {
		return errorResult(`No plugin with id '${id}'. Use list_plugins to see available ids.`);
	}

	const already = plugins.enabledPlugins.has(id);
	if (already === enabled) {
		return textResult(`Plugin '${id}' is already ${enabled ? "enabled" : "disabled"}.`);
	}

	try {
		if (enabled) {
			await plugins.enablePluginAndSave(id);
		} else {
			await plugins.disablePluginAndSave(id);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return errorResult(`Failed to ${enabled ? "enable" : "disable"} '${id}': ${msg}`);
	}

	// A plugin's onload is async and often logs during startup; waiting here lets
	// a follow-up read_console see that output instead of racing it.
	const rawDelay = typeof args.delay_ms === "number" ? args.delay_ms : 0;
	const delay = Math.min(Math.max(rawDelay, 0), 10000);
	if (delay > 0) {
		await new Promise((resolve) => setTimeout(resolve, delay));
	}

	const waited = delay > 0 ? ` (waited ${delay}ms)` : "";
	return textResult(`Plugin '${id}' ${enabled ? "enabled" : "disabled"} (saved).${waited}`);
}

async function handleListCommands(
	app: App,
	args: Record<string, unknown>
): Promise<ToolResult> {
	if (!getInternalCommands(app)) {
		return errorResult("Command API is unavailable in this Obsidian version.");
	}

	let commands = listCommands(app);
	const filter = args.filter ? String(args.filter).toLowerCase() : "";
	if (filter) {
		commands = commands.filter(
			(c) => c.id.toLowerCase().includes(filter) || c.name.toLowerCase().includes(filter)
		);
	}

	if (commands.length === 0) {
		return textResult(filter ? `No commands match '${filter}'.` : "No commands found.");
	}

	const lines = commands.map((c) => `${c.id}  —  ${c.name}`);
	return textResult(
		`${commands.length} command${commands.length === 1 ? "" : "s"}:\n${lines.join("\n")}`
	);
}

async function handleRunCommand(
	app: App,
	args: Record<string, unknown>
): Promise<ToolResult> {
	const commands = getInternalCommands(app);
	if (!commands) {
		return errorResult("Command API is unavailable in this Obsidian version.");
	}

	const id = String(args.id || "").trim();
	if (!id) return errorResult("id is required");

	const cmd = commands.commands[id];
	if (!cmd) {
		return errorResult(`No command with id '${id}'. Use list_commands to see available ids.`);
	}

	if (isDestructiveCommand(cmd) && !Boolean(args.confirm)) {
		return errorResult(
			`Command '${id}' (${cmd.name}) looks potentially destructive. Re-run with confirm:true to execute it.`
		);
	}

	const ran = commands.executeCommandById(id);
	if (!ran) {
		return textResult(
			`Command '${id}' (${cmd.name}) did not run — it likely requires a specific context (active editor, selection, or view) that isn't present.`
		);
	}
	return textResult(`Ran command '${id}' (${cmd.name}).`);
}

export async function handleToolCall(
	ctx: ToolContext,
	name: string,
	args: Record<string, unknown>
): Promise<ToolResult> {
	const { app, excludedPaths } = ctx;
	const checkAccess = (path: string | null): ToolResult | null => {
		if (path && !isPathAllowed(path, excludedPaths))
			return errorResult(`Access denied: '${path}' is in an excluded folder`);
		return null;
	};

	try {
		switch (name) {
			case "rename_file": {
				const oldPath = normalizePath(String(args.old_path || ""));
				const newPath = normalizePath(String(args.new_path || ""));
				const denied = checkAccess(oldPath) || checkAccess(newPath);
				if (denied) return denied;
				return await handleRenameFile(app, args);
			}
			case "create_folder": {
				const denied = checkAccess(normalizePath(String(args.path || "")));
				if (denied) return denied;
				return await handleCreateFolder(app, args);
			}
			case "delete_file": {
				const denied = checkAccess(normalizePath(String(args.path || "")));
				if (denied) return denied;
				return await handleDeleteFile(app, args);
			}
			case "list_files":
				return await handleListFiles(app, args, excludedPaths);
			case "read_file": {
				const denied = checkAccess(normalizePath(String(args.path || "")));
				if (denied) return denied;
				return await handleReadFile(app, args);
			}
			case "write_file": {
				const denied = checkAccess(normalizePath(String(args.path || "")));
				if (denied) return denied;
				return await handleWriteFile(app, args);
			}
			case "append_to_file": {
				const denied = checkAccess(normalizePath(String(args.path || "")));
				if (denied) return denied;
				return await handleAppendToFile(app, args);
			}
			case "find_backlinks": {
				const denied = checkAccess(normalizePath(String(args.path || "")));
				if (denied) return denied;
				return await handleFindBacklinks(app, args, excludedPaths);
			}
			case "search_vault":
				return await handleSearchVault(app, args, excludedPaths);
			case "query_frontmatter":
				return await handleQueryFrontmatter(app, args, excludedPaths);
			case "find_broken_links": {
				if (args.path) {
					const denied = checkAccess(normalizePath(String(args.path)));
					if (denied) return denied;
				}
				return await handleFindBrokenLinks(app, args, excludedPaths);
			}
			case "query_by_tag":
				return await handleQueryByTag(app, args, excludedPaths);
			case "update_frontmatter": {
				const denied = checkAccess(normalizePath(String(args.path || "")));
				if (denied) return denied;
				return await handleUpdateFrontmatter(app, args);
			}
			case "search_replace":
				return await handleSearchReplace(app, args, excludedPaths);
			case "patch_content": {
				const denied = checkAccess(normalizePath(String(args.path || "")));
				if (denied) return denied;
				return await handlePatchContent(app, args);
			}
			case "open_file": {
				const denied = checkAccess(normalizePath(String(args.path || "")));
				if (denied) return denied;
				return await handleOpenFile(app, args);
			}
			case "semantic_search":
				return await handleSemanticSearch(ctx, args);
			case "find_related_notes": {
				const denied = checkAccess(normalizePath(String(args.path || "")));
				if (denied) return denied;
				return await handleFindRelatedNotes(ctx, args);
			}
			case "list_templates":
				return await handleListTemplates(app);
			case "create_from_template": {
				const denied = checkAccess(normalizePath(String(args.target_path || "")));
				if (denied) return denied;
				return await handleCreateFromTemplate(app, args);
			}
			case "get_vault_info":
				return await handleGetVaultInfo(app);
			case "read_console":
				return await handleReadConsole(ctx, args);
			case "clear_console":
				return await handleClearConsole(ctx);
			case "list_plugins":
				return await handleListPlugins(app, args);
			case "set_plugin_enabled":
				return await handleSetPluginEnabled(app, args);
			case "list_commands":
				return await handleListCommands(app, args);
			case "run_command":
				return await handleRunCommand(app, args);
			default:
				return errorResult(`Unknown tool: ${name}`);
		}
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return errorResult(`Tool error: ${message}`);
	}
}
