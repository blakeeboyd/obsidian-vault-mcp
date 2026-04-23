export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
	};
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

export interface ToolToggles {
	rename_file: boolean;
	create_folder: boolean;
	delete_file: boolean;
	list_files: boolean;
	read_file: boolean;
	write_file: boolean;
	find_backlinks: boolean;
	search_vault: boolean;
	query_frontmatter: boolean;
	find_broken_links: boolean;
	query_by_tag: boolean;
	update_frontmatter: boolean;
	search_replace: boolean;
	patch_content: boolean;
	open_file: boolean;
	semantic_search: boolean;
	list_templates: boolean;
	create_from_template: boolean;
	get_vault_info: boolean;
}

export interface SemanticSettings {
	// Must be explicitly enabled — first use downloads a ~25MB model.
	enabled: boolean;
	// Re-embed on file modify events. Off by default: indexing is debounced
	// manually via the Reindex command, which is gentler on slow machines.
	autoReindex: boolean;
}

export interface VaultMcpSettings {
	port: number;
	// If the configured port is busy, try the next few ports and persist
	// whichever one we end up binding. Helpful when running the plugin in
	// multiple vaults simultaneously.
	autoPortIncrement: boolean;
	enabledTools: ToolToggles;
	excludedPaths: string[];
	semantic: SemanticSettings;
}

export const DEFAULT_SETTINGS: VaultMcpSettings = {
	port: 27182,
	autoPortIncrement: true,
	enabledTools: {
		rename_file: true,
		create_folder: true,
		delete_file: true,
		list_files: true,
		read_file: true,
		write_file: true,
		find_backlinks: true,
		search_vault: true,
		query_frontmatter: true,
		find_broken_links: true,
		query_by_tag: true,
		update_frontmatter: true,
		search_replace: true,
		patch_content: true,
		open_file: true,
		semantic_search: true,
		list_templates: true,
		create_from_template: true,
		get_vault_info: true,
	},
	excludedPaths: [],
	semantic: {
		enabled: false,
		autoReindex: false,
	},
};
