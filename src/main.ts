import {
	Plugin,
	PluginSettingTab,
	App,
	Setting,
	Notice,
	Modal,
	TFolder,
	TFile,
	TAbstractFile,
	normalizePath,
} from "obsidian";
import { VaultMcpSettings, DEFAULT_SETTINGS, ToolToggles } from "./types";
import { McpHttpServer } from "./server";
import { handleMcpRequest } from "./handlers";
import { TOOL_CATEGORIES } from "./tools";
import { SemanticIndex } from "./semantic";

const AUTO_PORT_TRIES = 10;

class ExcludedFoldersModal extends Modal {
	private plugin: VaultMcpPlugin;
	private onClose_callback: () => void;
	private filter = "";
	private expanded: Set<string> = new Set();

	constructor(app: App, plugin: VaultMcpPlugin, onCloseCallback: () => void) {
		super(app);
		this.plugin = plugin;
		this.onClose_callback = onCloseCallback;
	}

	onOpen(): void {
		this.modalEl.addClass("vault-mcp-folder-modal");
		this.injectStyles();
		this.renderContent();
	}

	private injectStyles(): void {
		const id = "vault-mcp-folder-styles";
		document.getElementById(id)?.remove();
		const style = document.createElement("style");
		style.id = id;
		style.textContent = `
			.vault-mcp-folder-list .setting-item {
				padding: 10px 0;
			}
			.vault-mcp-folder-list .setting-item .setting-item-info {
				gap: 0;
			}
			.vault-mcp-folder-list .setting-item .setting-item-name {
				font-size: var(--font-ui-small);
				word-break: break-word;
			}
			.vault-mcp-folder-list .setting-item .setting-item-description {
				font-size: var(--font-smallest);
			}
		`;
		document.head.appendChild(style);
	}

	onClose(): void {
		this.onClose_callback();
	}

	private getAllFolders(): TFolder[] {
		const folders: TFolder[] = [];
		for (const item of this.app.vault.getAllLoadedFiles()) {
			if (item instanceof TFolder && item.path !== "/") {
				folders.push(item);
			}
		}
		return folders.sort((a, b) => a.path.localeCompare(b.path));
	}

	private isTopLevel(folder: TFolder): boolean {
		return !folder.path.includes("/");
	}

	private getChildFolders(parent: TFolder): TFolder[] {
		return parent.children
			.filter((c): c is TFolder => c instanceof TFolder)
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	private getExcludedParent(path: string): string | null {
		const excluded = this.plugin.settings.excludedPaths;
		for (const ex of excluded) {
			if (path !== ex && path.startsWith(ex + "/")) {
				return ex;
			}
		}
		return null;
	}

	private renderContent(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Excluded Folders" });

		const count = this.plugin.settings.excludedPaths.length;
		contentEl.createEl("p", {
			text: count === 0
				? "No folders excluded. The entire vault is accessible."
				: `${count} folder${count === 1 ? "" : "s"} excluded.`,
			cls: "setting-item-description",
		});

		const hasFilter = this.filter.trim().length > 0;
		const searchDesc = hasFilter
			? "Showing all matching folders. Subfolders inherit exclusions from their parents."
			: "Expand folders to browse subfolders, or search to find any folder.";

		new Setting(contentEl)
			.setName("Search folders")
			.setDesc(searchDesc)
			.addText((text) => {
				text.setPlaceholder("Type to find subfolders...")
					.setValue(this.filter)
					.onChange((value) => {
						this.filter = value;
						this.renderFolderList(listContainer);
					});
				text.inputEl.focus();
			});

		const listContainer = contentEl.createDiv({ cls: "vault-mcp-folder-list" });
		this.renderFolderList(listContainer);
	}

	private renderFolderRow(
		container: HTMLElement,
		folder: TFolder,
		indent: number,
		children: TFolder[]
	): void {
		const excluded = this.plugin.settings.excludedPaths;
		const isDirectlyExcluded = excluded.includes(folder.path);
		const inheritedFrom = this.getExcludedParent(folder.path);
		const isInherited = inheritedFrom !== null;
		const hasChildren = children.length > 0;
		const isExpanded = this.expanded.has(folder.path);

		const setting = new Setting(container);
		if (indent > 0) {
			setting.settingEl.style.paddingLeft = `${indent * 24}px`;
		}

		if (hasChildren) {
			const arrow = isExpanded ? "▼" : "▶";
			setting.setName(`${arrow}  ${folder.name}`);
			setting.nameEl.style.cursor = "pointer";
			setting.nameEl.addEventListener("click", (e) => {
				e.preventDefault();
				if (this.expanded.has(folder.path)) {
					this.expanded.delete(folder.path);
				} else {
					this.expanded.add(folder.path);
				}
				this.renderFolderList(container);
			});
		} else {
			setting.setName(indent > 0 ? folder.name : folder.path);
		}

		if (isInherited) {
			setting
				.setDesc(`Inherited from ${inheritedFrom}`)
				.addToggle((toggle) => {
					toggle
						.setValue(true)
						.setTooltip(`Excluded via ${inheritedFrom}`)
						.onChange(() => {
							toggle.setValue(true);
						});
					toggle.toggleEl.style.opacity = "0.4";
				});
		} else {
			setting
				.setDesc(isDirectlyExcluded ? "Excluded" : "Accessible")
				.addToggle((toggle) => {
					toggle
						.setValue(isDirectlyExcluded)
						.setTooltip(isDirectlyExcluded ? "Click to allow access" : "Click to exclude")
						.onChange(async (value) => {
							if (value && !excluded.includes(folder.path)) {
								excluded.push(folder.path);
							} else if (!value) {
								const idx = excluded.indexOf(folder.path);
								if (idx >= 0) excluded.splice(idx, 1);
							}
							await this.plugin.saveSettings();
							this.renderContent();
						});
				});
		}
	}

	private renderFolderTree(
		container: HTMLElement,
		folder: TFolder,
		indent: number
	): void {
		const children = this.getChildFolders(folder);
		this.renderFolderRow(container, folder, indent, children);

		if (children.length > 0 && this.expanded.has(folder.path)) {
			for (const child of children) {
				this.renderFolderTree(container, child, indent + 1);
			}
		}
	}

	private renderFolderList(container: HTMLElement): void {
		container.empty();
		const folders = this.getAllFolders();
		const lowerFilter = this.filter.trim().toLowerCase();
		const hasFilter = lowerFilter.length > 0;

		if (hasFilter) {
			for (const folder of folders) {
				if (!folder.path.toLowerCase().includes(lowerFilter)) continue;
				this.renderFolderRow(container, folder, 0, []);
			}
		} else {
			for (const folder of folders) {
				if (!this.isTopLevel(folder)) continue;
				this.renderFolderTree(container, folder, 0);
			}
		}

		if (container.childElementCount === 0) {
			container.createEl("p", {
				text: "No folders match your search.",
				cls: "setting-item-description",
			});
		}
	}
}

export default class VaultMcpPlugin extends Plugin {
	settings: VaultMcpSettings = DEFAULT_SETTINGS;
	server: McpHttpServer | null = null;
	semanticIndex: SemanticIndex | null = null;
	// Updated by reindex runs; reflected in the settings tab.
	semanticProgress: { done: number; total: number } | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new VaultMcpSettingTab(this.app, this));
		await this.startServer();

		if (this.settings.semantic.enabled) {
			this.initSemanticIndex();
		}

		this.registerFileEvents();

		this.addCommand({
			id: "reindex-semantic",
			name: "Semantic search: reindex vault",
			callback: () => this.reindexSemantic(),
		});
		this.addCommand({
			id: "clear-semantic-index",
			name: "Semantic search: clear index",
			callback: () => this.clearSemanticIndex(),
		});
	}

	async onunload(): Promise<void> {
		await this.stopServer();
	}

	async startServer(): Promise<void> {
		let port = this.settings.port;
		const maxTries = this.settings.autoPortIncrement ? AUTO_PORT_TRIES : 1;
		let lastErr: NodeJS.ErrnoException | null = null;

		for (let attempt = 0; attempt < maxTries; attempt++) {
			try {
				const server = new McpHttpServer(port, (request) =>
					handleMcpRequest(this.app, this.settings, this.semanticIndex, request)
				);
				await server.start();
				this.server = server;
				if (port !== this.settings.port) {
					const original = this.settings.port;
					this.settings.port = port;
					await this.saveSettings();
					new Notice(
						`Vault MCP: port ${original} was busy, using ${port} instead.`
					);
				}
				console.log(
					`vault-mcp: listening on http://127.0.0.1:${port}/mcp (vault: ${this.app.vault.getName()})`
				);
				return;
			} catch (err: unknown) {
				lastErr = err as NodeJS.ErrnoException;
				if (lastErr.code === "EADDRINUSE" && attempt < maxTries - 1) {
					port++;
					continue;
				}
				break;
			}
		}

		if (lastErr?.code === "EADDRINUSE") {
			new Notice(
				`Vault MCP: could not find a free port starting from ${this.settings.port}. Change it in settings.`
			);
		} else if (lastErr) {
			new Notice(`Vault MCP: failed to start server: ${lastErr.message}`);
		}
		this.server = null;
	}

	async stopServer(): Promise<void> {
		if (this.server) {
			await this.server.stop();
			this.server = null;
		}
	}

	async restartServer(): Promise<void> {
		await this.stopServer();
		await this.startServer();
	}

	initSemanticIndex(): SemanticIndex {
		if (this.semanticIndex) return this.semanticIndex;
		const dir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
		const indexPath = normalizePath(`${dir}/embeddings.jsonl`);
		const metaPath = normalizePath(`${dir}/embeddings-meta.json`);
		this.semanticIndex = new SemanticIndex(this.app, indexPath, metaPath);
		// Pre-load the stored index in the background. Model downloads lazily
		// on first search or reindex.
		this.semanticIndex.load().catch((err) =>
			console.error("vault-mcp: failed to load semantic index:", err)
		);
		return this.semanticIndex;
	}

	async reindexSemantic(): Promise<void> {
		if (!this.settings.semantic.enabled) {
			new Notice("Vault MCP: enable semantic search in settings first.");
			return;
		}
		const index = this.initSemanticIndex();
		new Notice("Vault MCP: starting semantic reindex…");
		this.semanticProgress = { done: 0, total: 0 };
		try {
			await index.reindexAll(this.settings.excludedPaths, (done, total) => {
				this.semanticProgress = { done, total };
			});
			new Notice("Vault MCP: semantic index rebuilt.");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Vault MCP: reindex failed: ${msg}`);
			console.error(err);
		} finally {
			this.semanticProgress = null;
		}
	}

	async clearSemanticIndex(): Promise<void> {
		const dir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
		const indexPath = normalizePath(`${dir}/embeddings.jsonl`);
		const metaPath = normalizePath(`${dir}/embeddings-meta.json`);
		const adapter = this.app.vault.adapter;
		if (await adapter.exists(indexPath)) await adapter.remove(indexPath);
		if (await adapter.exists(metaPath)) await adapter.remove(metaPath);
		this.semanticIndex = null;
		new Notice("Vault MCP: semantic index cleared.");
	}

	private registerFileEvents(): void {
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!(file instanceof TFile)) return;
				if (file.extension !== "md") return;
				if (!this.settings.semantic.enabled) return;
				if (!this.settings.semantic.autoReindex) return;
				if (!this.semanticIndex) return;
				this.semanticIndex
					.reindexFile(file)
					.catch((err) => console.error("vault-mcp: auto-reindex failed:", err));
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (!this.semanticIndex) return;
				this.semanticIndex.removeFile(file.path).catch(() => {});
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (!this.semanticIndex) return;
				this.semanticIndex.renameFile(oldPath, file.path).catch(() => {});
			})
		);
	}

	async loadSettings(): Promise<void> {
		const saved = ((await this.loadData()) || {}) as Partial<VaultMcpSettings> & {
			allowedPaths?: unknown;
		};
		delete saved.allowedPaths;
		this.settings = {
			...DEFAULT_SETTINGS,
			...saved,
			enabledTools: {
				...DEFAULT_SETTINGS.enabledTools,
				...(saved.enabledTools || {}),
			},
			semantic: {
				...DEFAULT_SETTINGS.semantic,
				...(saved.semantic || {}),
			},
		};
		if (!Array.isArray(this.settings.excludedPaths)) {
			this.settings.excludedPaths = [];
		}
	}

	async saveSettings(): Promise<void> {
		this.settings.excludedPaths = this.settings.excludedPaths.filter(
			(p) => p.trim().length > 0
		);
		await this.saveData(this.settings);
	}
}

class VaultMcpSettingTab extends PluginSettingTab {
	plugin: VaultMcpPlugin;

	constructor(app: App, plugin: VaultMcpPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Vault MCP Server" });

		const vaultName = this.plugin.app.vault.getName();
		const statusEl = containerEl.createDiv({ cls: "vault-mcp-status" });
		statusEl.createEl("p", { text: `Vault: ${vaultName}` });
		if (this.plugin.server) {
			statusEl.createEl("p", {
				text: `Status: Running on http://127.0.0.1:${this.plugin.settings.port}/mcp`,
			});
		} else {
			statusEl.createEl("p", { text: "Status: Not running" });
		}

		new Setting(containerEl)
			.setName("Port")
			.setDesc("HTTP port for the MCP server. Restarts on change.")
			.addText((text) =>
				text
					.setPlaceholder("27182")
					.setValue(String(this.plugin.settings.port))
					.onChange(async (value) => {
						const port = parseInt(value, 10);
						if (port >= 1024 && port <= 65535) {
							this.plugin.settings.port = port;
							await this.plugin.saveSettings();
							await this.plugin.restartServer();
							this.display();
						}
					})
			);

		new Setting(containerEl)
			.setName("Auto-increment port if busy")
			.setDesc(
				"If the configured port is in use (e.g., another vault is running the plugin), try the next few ports and save whichever one binds."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoPortIncrement)
					.onChange(async (value) => {
						this.plugin.settings.autoPortIncrement = value;
						await this.plugin.saveSettings();
					})
			);

		for (const category of TOOL_CATEGORIES) {
			containerEl.createEl("h3", { text: category.heading });
			containerEl.createEl("p", {
				text: category.description,
				cls: "setting-item-description",
			});

			const toolNames = Object.keys(category.tools) as Array<keyof ToolToggles>;
			for (const toolName of toolNames) {
				const label = category.tools[toolName];
				new Setting(containerEl)
					.setName(label.name)
					.setDesc(label.desc)
					.addToggle((toggle) =>
						toggle
							.setValue(this.plugin.settings.enabledTools[toolName])
							.onChange(async (value) => {
								this.plugin.settings.enabledTools[toolName] = value;
								await this.plugin.saveSettings();
							})
					);
			}
		}

		this.renderSemanticSection(containerEl);

		containerEl.createEl("h3", { text: "Access" });

		const excluded = this.plugin.settings.excludedPaths;
		const count = excluded.length;
		const desc = count === 0
			? "No folders excluded. The entire vault is accessible."
			: `${count} folder${count === 1 ? "" : "s"} excluded: ${excluded.join(", ")}`;

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc(desc)
			.addButton((button) => {
				button.setButtonText("Manage").onClick(() => {
					new ExcludedFoldersModal(this.app, this.plugin, () => {
						this.display();
					}).open();
				});
			});

		containerEl.createEl("h3", { text: "Connect from Claude Code" });
		containerEl.createEl("p", {
			text: `Register this vault with Claude Code (one entry per vault if running in multiple):`,
			cls: "setting-item-description",
		});
		const connectName = `vault-${vaultName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
		const codeEl = containerEl.createEl("pre");
		codeEl.createEl("code", {
			text: `claude mcp add --transport http ${connectName} http://localhost:${this.plugin.settings.port}/mcp`,
		});

		containerEl.createEl("p", {
			text: "Or project-scoped (only active in a specific directory):",
			cls: "setting-item-description",
		});
		const codeEl2 = containerEl.createEl("pre");
		codeEl2.createEl("code", {
			text: `claude mcp add --transport http --scope project ${connectName} http://localhost:${this.plugin.settings.port}/mcp`,
		});
	}

	private renderSemanticSection(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: "Semantic Search" });
		containerEl.createEl("p", {
			text:
				"Runs locally via all-MiniLM-L6-v2 (384-dim). First use downloads " +
				"the model (~25 MB) from Hugging Face. The index lives inside the plugin folder.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Enable semantic search")
			.setDesc(
				"When enabled, the plugin can build and query a local embeddings index over the vault."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.semantic.enabled)
					.onChange(async (value) => {
						this.plugin.settings.semantic.enabled = value;
						await this.plugin.saveSettings();
						if (value) this.plugin.initSemanticIndex();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Auto-reindex on file change")
			.setDesc(
				"Re-embed a file whenever it is modified. Off by default to keep edits snappy — use the Reindex button for scheduled rebuilds."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.semantic.autoReindex)
					.onChange(async (value) => {
						this.plugin.settings.semantic.autoReindex = value;
						await this.plugin.saveSettings();
					})
			);

		const statusEl = containerEl.createDiv({ cls: "vault-mcp-status" });
		if (!this.plugin.settings.semantic.enabled) {
			statusEl.createEl("p", { text: "Status: disabled" });
		} else {
			const index = this.plugin.semanticIndex;
			const status = index
				? index.status(true)
				: { indexing: false, indexedFiles: 0, totalChunks: 0, lastIndexed: null };
			if (this.plugin.semanticProgress) {
				const { done, total } = this.plugin.semanticProgress;
				statusEl.createEl("p", { text: `Indexing: ${done}/${total}` });
			} else if (status.indexing) {
				statusEl.createEl("p", { text: "Indexing…" });
			} else if (status.indexedFiles > 0) {
				statusEl.createEl("p", {
					text: `Indexed: ${status.indexedFiles} files, ${status.totalChunks} chunks`,
				});
				if (status.lastIndexed) {
					const when = new Date(status.lastIndexed).toLocaleString();
					statusEl.createEl("p", { text: `Last updated: ${when}` });
				}
			} else {
				statusEl.createEl("p", {
					text: "No index yet. Click Reindex to build one.",
				});
			}
		}

		new Setting(containerEl)
			.setName("Reindex vault")
			.setDesc(
				"Rebuild the semantic index over every markdown file. Incremental — only files with changed mtime are re-embedded."
			)
			.addButton((button) =>
				button
					.setButtonText("Reindex")
					.setDisabled(!this.plugin.settings.semantic.enabled)
					.onClick(async () => {
						button.setDisabled(true);
						await this.plugin.reindexSemantic();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Clear index")
			.setDesc("Delete the stored embeddings. Model cache is untouched.")
			.addButton((button) =>
				button
					.setButtonText("Clear")
					.setWarning()
					.onClick(async () => {
						await this.plugin.clearSemanticIndex();
						this.display();
					})
			);
	}
}
