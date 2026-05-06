import {
	Plugin,
	PluginSettingTab,
	App,
	Setting,
	Notice,
	Modal,
	MarkdownRenderer,
	Component,
	TFolder,
	TFile,
	TAbstractFile,
	normalizePath,
} from "obsidian";
import { VaultMcpSettings, DEFAULT_SETTINGS, ToolToggles } from "./types";
import { McpHttpServer } from "./server";
import { handleMcpRequest } from "./handlers";
import { TOOL_CATEGORIES } from "./tools";
import { SemanticIndex, RelatedNote, chunkMarkdown } from "./semantic";

const AUTO_PORT_TRIES = 10;

function formatProgress(label: string, done: number, total: number): string {
	const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
	return `Vault MCP: ${label} ${done}/${total} (${pct}%)`;
}

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

// Cap on rendered chunk length per row. Full chunks can be 1500 chars;
// rendering all of them would overwhelm the modal. 600 keeps rows scannable
// while preserving paragraph structure that the flat preview loses.
const RENDER_CHUNK_MAX_CHARS = 600;

// Cosine-similarity bands for the modal's at-a-glance score indicator.
// Thresholds match the MCP-side scoreBand function so both surfaces
// describe the same result the same way.
function scoreBandLabel(score: number): {
	key: "strong" | "moderate" | "loose" | "weak";
	label: string;
	dots: number;
} {
	if (score >= 0.85) return { key: "strong", label: "strong", dots: 3 };
	if (score >= 0.7) return { key: "moderate", label: "moderate", dots: 2 };
	if (score >= 0.55) return { key: "loose", label: "loose", dots: 1 };
	return { key: "weak", label: "weak", dots: 0 };
}

class RelatedNotesModal extends Modal {
	private plugin: VaultMcpPlugin;
	private sourceFile: TFile;
	// Owns the lifecycle of MarkdownRenderer-mounted children so they
	// unload cleanly when the modal closes.
	private renderHost: Component = new Component();

	constructor(app: App, plugin: VaultMcpPlugin, sourceFile: TFile) {
		super(app);
		this.plugin = plugin;
		this.sourceFile = sourceFile;
	}

	onClose(): void {
		this.renderHost.unload();
	}

	private headerText(): string {
		const fm = this.app.metadataCache.getFileCache(this.sourceFile)?.frontmatter;
		const raw = fm?.aliases ?? fm?.alias;
		if (raw !== undefined && raw !== null) {
			const list = Array.isArray(raw) ? raw : [raw];
			const first = list
				.map((v) => (typeof v === "string" ? v.trim() : String(v)))
				.find((v) => v.length > 0);
			if (first) {
				return `Related to: ${this.sourceFile.basename} — ${first}`;
			}
		}
		return `Related to: ${this.sourceFile.basename}`;
	}

	onOpen(): void {
		this.modalEl.addClass("vault-mcp-related-modal");
		this.injectStyles();
		this.renderLoading();
		this.runSearch().catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			this.renderError(msg);
		});
	}

	private injectStyles(): void {
		const id = "vault-mcp-related-styles";
		// Remove any existing style element from a previous plugin load.
		// Without this, stale CSS from an older session blocks new rules
		// from taking effect (the early-return check in the prior version
		// hit the cached element and skipped reinjection).
		document.getElementById(id)?.remove();
		const style = document.createElement("style");
		style.id = id;
		style.textContent = `
			.vault-mcp-related-modal .related-row {
				padding: 12px 14px;
				cursor: pointer;
				border-radius: 6px;
				margin-bottom: 10px;
				border: 1px solid var(--background-modifier-border);
				background: var(--background-secondary);
			}
			.vault-mcp-related-modal .related-row:hover {
				background: var(--background-modifier-hover);
			}
			.vault-mcp-related-modal .related-header {
				display: flex;
				align-items: baseline;
				flex-wrap: wrap;
			}
			.vault-mcp-related-modal .related-title {
				font-weight: 600;
				font-size: var(--font-ui-medium);
				flex: 1 1 auto;
				margin-right: 12px;
			}
			.vault-mcp-related-modal .related-subtitle {
				color: var(--text-faint);
				font-size: var(--font-smallest);
				font-family: var(--font-monospace);
				margin-top: 2px;
			}
			.vault-mcp-related-modal .related-band {
				font-size: var(--font-smallest);
				font-weight: 500;
				text-transform: uppercase;
				letter-spacing: 0.5px;
				white-space: nowrap;
				margin-right: 8px;
			}
			.vault-mcp-related-modal .related-band-strong {
				color: #4ade80;
			}
			.vault-mcp-related-modal .related-band-moderate {
				color: #facc15;
			}
			.vault-mcp-related-modal .related-band-loose {
				color: var(--text-muted);
			}
			.vault-mcp-related-modal .related-band-weak {
				color: var(--text-faint);
			}
			.vault-mcp-related-modal .related-link-badge {
				font-size: var(--font-smallest);
				padding: 2px 8px;
				border-radius: 10px;
				background: var(--interactive-accent);
				color: var(--text-on-accent);
				white-space: nowrap;
			}
			.vault-mcp-related-modal .related-aka {
				color: var(--text-muted);
				font-size: var(--font-smallest);
				margin-top: 2px;
				font-style: italic;
			}
			.vault-mcp-related-modal .related-summary {
				margin-top: 8px;
				color: var(--text-normal);
				font-size: var(--font-ui-small);
				line-height: 1.5;
			}
			.vault-mcp-related-modal .related-summary > *:first-child {
				margin-top: 0;
			}
			.vault-mcp-related-modal .related-summary > *:last-child {
				margin-bottom: 0;
			}
			.vault-mcp-related-modal .related-snippet {
				color: var(--text-muted);
				font-size: var(--font-ui-small);
				margin-top: 8px;
				border-left: 2px solid var(--background-modifier-border);
				padding-left: 10px;
				line-height: 1.5;
			}
			.vault-mcp-related-modal .related-snippet > *:first-child {
				margin-top: 0;
			}
			.vault-mcp-related-modal .related-snippet > *:last-child {
				margin-bottom: 0;
			}
			.vault-mcp-related-modal .related-shared {
				margin-top: 10px;
				padding-top: 8px;
				border-top: 1px solid var(--background-modifier-border);
				font-size: var(--font-smallest);
				color: var(--text-muted);
				display: flex;
				flex-wrap: wrap;
				gap: 12px;
			}
			.vault-mcp-related-modal .related-shared-label {
				font-weight: 500;
				color: var(--text-faint);
			}
			.vault-mcp-related-modal .related-actions {
				margin-top: 10px;
				display: flex;
				gap: 6px;
			}
			.vault-mcp-related-modal .related-actions button {
				font-size: var(--font-smallest);
				padding: 3px 10px;
			}
		`;
		document.head.appendChild(style);
	}

	private renderLoading(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: this.headerText() });
		contentEl.createEl("p", {
			text: "Searching…",
			cls: "setting-item-description",
		});
	}

	private renderError(msg: string): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: this.headerText() });
		contentEl.createEl("p", { text: msg, cls: "setting-item-description" });
	}

	private async runSearch(): Promise<void> {
		if (!this.plugin.settings.semantic.enabled) {
			this.renderError(
				"Semantic search is not enabled. Turn it on in Vault MCP settings and run Reindex first."
			);
			return;
		}
		const index = this.plugin.semanticIndex;
		if (!index) {
			this.renderError("Semantic index not initialized.");
			return;
		}
		const results = await index.findRelatedNotes(this.sourceFile.path, {
			limit: 15,
			excludedPaths: this.plugin.settings.excludedPaths,
		});
		this.renderResults(results);
	}

	private renderResults(results: RelatedNote[]): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: this.headerText() });

		if (results.length === 0) {
			contentEl.createEl("p", {
				text: "No related notes found.",
				cls: "setting-item-description",
			});
			return;
		}

		contentEl.createEl("p", {
			text: "Click a row to open. Cmd/Ctrl+click for new tab. Use Copy wikilink to link from your active note.",
			cls: "setting-item-description",
		});

		const list = contentEl.createDiv();
		// Mount the render host so MarkdownRenderer.render has a Component
		// ancestor to unload its bookkeeping into. Created in the constructor
		// but loaded here to tie its lifecycle to result rendering.
		this.renderHost.load();
		for (const r of results) {
			const row = list.createDiv({ cls: "related-row" });

			// Header: alias as title (path is opaque without it), score band,
			// optional "linked" badge. Path moves to a muted subtitle below.
			const header = row.createDiv({ cls: "related-header" });
			const titleText =
				r.aliases && r.aliases.length > 0 ? r.aliases[0] : r.path;
			header.createSpan({ text: titleText, cls: "related-title" });

			const band = scoreBandLabel(r.score);
			const bandEl = header.createSpan({
				text: band.label,
				cls: `related-band related-band-${band.key}`,
			});
			bandEl.title = `cosine ${r.score.toFixed(3)}`;

			if (r.directLink) {
				const arrow =
					r.directLink === "outgoing"
						? "→"
						: r.directLink === "incoming"
							? "←"
							: "↔";
				header.createSpan({
					text: `${arrow} linked`,
					cls: "related-link-badge",
				});
			}

			// Subtitle: path (always shown for unambiguous reference) plus any
			// additional aliases beyond the title one, kept compact.
			const subtitle = row.createDiv({ cls: "related-subtitle" });
			subtitle.setText(r.path);
			if (r.aliases && r.aliases.length > 1) {
				row.createDiv({
					text: `also: ${r.aliases.slice(1).join(", ")}`,
					cls: "related-aka",
				});
			}

			// Summary (rendered) when present, chunk excerpt otherwise.
			// Both go through MarkdownRenderer so wikilinks are clickable.
			if (r.summary) {
				const summaryEl = row.createDiv({ cls: "related-summary" });
				MarkdownRenderer.render(
					this.app,
					r.summary,
					summaryEl,
					r.path,
					this.renderHost
				).catch(() => {
					summaryEl.empty();
					summaryEl.setText(r.summary!);
				});
			} else {
				const snippetEl = row.createDiv({ cls: "related-snippet" });
				this.renderChunkMarkdown(snippetEl, r).catch(() => {
					snippetEl.empty();
					snippetEl.setText(r.snippet);
				});
			}

			if (
				(r.sharedLinks && r.sharedLinks.length > 0) ||
				(r.sharedTags && r.sharedTags.length > 0)
			) {
				const sharedEl = row.createDiv({ cls: "related-shared" });
				if (r.sharedLinks && r.sharedLinks.length > 0) {
					const part = sharedEl.createSpan();
					part.createSpan({
						text: "shared: ",
						cls: "related-shared-label",
					});
					this.renderSharedLinks(part, r.sharedLinks);
				}
				if (r.sharedTags && r.sharedTags.length > 0) {
					const part = sharedEl.createSpan();
					part.createSpan({
						text: "tags: ",
						cls: "related-shared-label",
					});
					part.createSpan({ text: r.sharedTags.join(", ") });
				}
			}

			const actions = row.createDiv({ cls: "related-actions" });
			const copyBtn = actions.createEl("button", { text: "Copy wikilink" });
			copyBtn.addEventListener("click", async (e) => {
				e.stopPropagation();
				await this.copyWikilink(r.path);
			});

			row.addEventListener("click", async (e) => {
				const target = e.target as HTMLElement;
				// Don't navigate when the click was inside a region that
				// owns its own click semantics (rendered wikilinks, buttons,
				// the shared-concepts row).
				if (target.tagName === "BUTTON") return;
				if (target.tagName === "A") return;
				if (target.closest(".related-snippet")) return;
				if (target.closest(".related-summary")) return;
				if (target.closest(".related-shared")) return;
				const newLeaf = e.metaKey || e.ctrlKey;
				const file = this.app.vault.getAbstractFileByPath(r.path);
				if (!(file instanceof TFile)) return;
				const leaf = newLeaf
					? this.app.workspace.getLeaf("tab")
					: this.app.workspace.getLeaf();
				await leaf.openFile(file);
				this.close();
			});
		}
	}

	private renderSharedLinks(container: HTMLElement, paths: string[]): void {
		paths.forEach((p, i) => {
			if (i > 0) container.appendText(", ");
			const file = this.app.vault.getAbstractFileByPath(p);
			if (file instanceof TFile) {
				const linktext = this.app.metadataCache.fileToLinktext(
					file,
					this.sourceFile.path,
					true
				);
				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
				const aliases = fm?.aliases ?? fm?.alias;
				let display = linktext;
				if (Array.isArray(aliases) && aliases.length > 0) {
					display = String(aliases[0]);
				} else if (typeof aliases === "string") {
					display = aliases;
				}
				const link = container.createEl("a", {
					text: display,
					cls: "internal-link",
					href: linktext,
				});
				link.addEventListener("click", async (e) => {
					e.preventDefault();
					e.stopPropagation();
					const newLeaf = e.metaKey || e.ctrlKey;
					const leaf = newLeaf
						? this.app.workspace.getLeaf("tab")
						: this.app.workspace.getLeaf();
					await leaf.openFile(file);
					this.close();
				});
			} else {
				container.appendText(p);
			}
		});
	}

	private async renderChunkMarkdown(
		el: HTMLElement,
		r: RelatedNote
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(r.path);
		if (!(file instanceof TFile)) {
			el.setText(r.snippet);
			return;
		}
		const content = await this.app.vault.cachedRead(file);
		const chunks = chunkMarkdown(r.path, content);
		const raw = chunks[r.chunkIndex] ?? chunks[0];
		if (!raw) {
			el.setText(r.snippet);
			return;
		}
		// chunkMarkdown prepends `${path}\n\n` as weak title context for the
		// embedder. Strip it before rendering so the user sees just body text.
		const body = raw.replace(/^[^\n]+\n\n/, "");
		const truncated =
			body.length > RENDER_CHUNK_MAX_CHARS
				? body.slice(0, RENDER_CHUNK_MAX_CHARS) + "…"
				: body;
		await MarkdownRenderer.render(
			this.app,
			truncated,
			el,
			r.path,
			this.renderHost
		);
	}

	private async copyWikilink(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`File not found: ${path}`);
			return;
		}
		// Always emit wikilink format regardless of vault settings — matches
		// the user's stated convention of never using markdown links.
		const linktext = this.app.metadataCache.fileToLinktext(
			file,
			this.sourceFile.path,
			file.extension === "md"
		);
		const wikilink = `[[${linktext}]]`;
		await navigator.clipboard.writeText(wikilink);
		new Notice(`Copied ${wikilink}`);
	}
}

// Auto-reindex debounce. modify/create events fire on every Obsidian autosave
// (~2s after typing stops). Re-embedding on every save chews main-thread time
// for no perceptible search-quality gain, so coalesce per file: a quiet
// window of this length must pass before re-embedding.
const AUTO_REINDEX_DEBOUNCE_MS = 15_000;

export default class VaultMcpPlugin extends Plugin {
	settings: VaultMcpSettings = DEFAULT_SETTINGS;
	server: McpHttpServer | null = null;
	semanticIndex: SemanticIndex | null = null;
	// Updated by reindex runs; reflected in the settings tab.
	semanticProgress: { done: number; total: number } | null = null;
	private reindexTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

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
		this.addCommand({
			id: "compact-semantic-index",
			name: "Semantic search: compact index (dedupe and rewrite)",
			callback: () => this.compactSemanticIndex(),
		});
		this.addCommand({
			id: "find-related-notes",
			name: "Semantic search: find related notes for active file",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!this.settings.semantic.enabled) return false;
				if (checking) return true;
				new RelatedNotesModal(this.app, this, file).open();
				return true;
			},
		});
	}

	async compactSemanticIndex(): Promise<void> {
		if (!this.settings.semantic.enabled) {
			new Notice("Vault MCP: enable semantic search in settings first.");
			return;
		}
		const index = this.initSemanticIndex();
		const notice = new Notice("Vault MCP: compacting semantic index…", 0);
		try {
			const result = await index.compactAndPersist();
			const dropped = result.chunksBefore - result.chunksAfter;
			const summary =
				dropped > 0
					? `Vault MCP: compacted — dropped ${dropped} duplicate chunks (${result.chunksBefore} → ${result.chunksAfter}, ${result.filesIndexed} files)`
					: `Vault MCP: index already clean — ${result.chunksAfter} chunks across ${result.filesIndexed} files`;
			console.log(summary);
			notice.setMessage(summary);
			setTimeout(() => notice.hide(), 6000);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			notice.setMessage(`Vault MCP: compact failed: ${msg}`);
			setTimeout(() => notice.hide(), 6000);
			console.error(err);
		}
	}

	async onunload(): Promise<void> {
		this.clearAllReindexTimers();
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
		// Defer the load until Obsidian's layout is ready. Parsing a 100MB+
		// embeddings.jsonl involves tens of thousands of JSON.parse +
		// base64-decode calls, and running those during plugin onload competes
		// with Obsidian's own startup work. Once layout is ready, kick off the
		// load and reconcile against current vault state. Model downloads
		// lazily — only triggered if the delta scan finds work to do.
		this.app.workspace.onLayoutReady(() => {
			this.semanticIndex
				?.load()
				.then(() => this.runDeltaScan())
				.catch((err) =>
					console.error("vault-mcp: failed to load semantic index:", err)
				);
		});
		return this.semanticIndex;
	}

	private async runDeltaScan(): Promise<void> {
		if (!this.semanticIndex) return;
		// Wait for the vault metadata cache so getMarkdownFiles() is populated.
		await new Promise<void>((resolve) =>
			this.app.workspace.onLayoutReady(() => resolve())
		);
		const notice = new Notice("Vault MCP: checking for changes…", 0);
		try {
			const result = await this.semanticIndex.deltaScan(
				this.settings.excludedPaths,
				(done, total) => {
					this.semanticProgress = { done, total };
					notice.setMessage(formatProgress("Delta scan", done, total));
				}
			);
			const { added, updated, removed } = result;
			if (added + updated + removed > 0) {
				const summary = `Vault MCP: delta scan — ${added} added, ${updated} updated, ${removed} removed`;
				console.log(summary);
				notice.setMessage(summary);
				setTimeout(() => notice.hide(), 4000);
			} else {
				notice.hide();
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("vault-mcp: delta scan failed:", err);
			notice.setMessage(`Vault MCP: delta scan failed: ${msg}`);
			setTimeout(() => notice.hide(), 6000);
		} finally {
			this.semanticProgress = null;
		}
	}

	async reindexSemantic(): Promise<void> {
		if (!this.settings.semantic.enabled) {
			new Notice("Vault MCP: enable semantic search in settings first.");
			return;
		}
		const index = this.initSemanticIndex();
		const notice = new Notice("Vault MCP: starting semantic reindex…", 0);
		this.semanticProgress = { done: 0, total: 0 };
		try {
			await index.reindexAll(this.settings.excludedPaths, (done, total) => {
				this.semanticProgress = { done, total };
				notice.setMessage(formatProgress("Reindexing", done, total));
			});
			notice.setMessage("Vault MCP: semantic index rebuilt.");
			setTimeout(() => notice.hide(), 4000);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			notice.setMessage(`Vault MCP: reindex failed: ${msg}`);
			setTimeout(() => notice.hide(), 6000);
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

	private scheduleReindex(file: TFile): void {
		const existing = this.reindexTimers.get(file.path);
		if (existing) clearTimeout(existing);
		const path = file.path;
		const timer = setTimeout(() => {
			this.reindexTimers.delete(path);
			if (!this.settings.semantic.enabled) return;
			if (!this.settings.semantic.autoReindex) return;
			if (!this.semanticIndex) return;
			// Re-resolve in case the file was renamed or deleted while pending.
			const current = this.app.vault.getAbstractFileByPath(path);
			if (!(current instanceof TFile)) return;
			this.semanticIndex
				.reindexFile(current)
				.catch((err) => console.error("vault-mcp: auto-reindex failed:", err));
		}, AUTO_REINDEX_DEBOUNCE_MS);
		this.reindexTimers.set(path, timer);
	}

	private clearReindexTimer(path: string): void {
		const timer = this.reindexTimers.get(path);
		if (timer) {
			clearTimeout(timer);
			this.reindexTimers.delete(path);
		}
	}

	private clearAllReindexTimers(): void {
		for (const timer of this.reindexTimers.values()) clearTimeout(timer);
		this.reindexTimers.clear();
	}

	private registerFileEvents(): void {
		const scheduleOnEvent = (file: TAbstractFile) => {
			if (!(file instanceof TFile)) return;
			if (file.extension !== "md") return;
			if (!this.settings.semantic.enabled) return;
			if (!this.settings.semantic.autoReindex) return;
			if (!this.semanticIndex) return;
			this.scheduleReindex(file);
		};
		this.registerEvent(this.app.vault.on("modify", scheduleOnEvent));
		// "create" covers new files written via the MCP write_file tool, which
		// goes through vault.create. Without this subscription, new files are
		// not embedded until the next manual reindex or delta scan.
		this.registerEvent(this.app.vault.on("create", scheduleOnEvent));
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				this.clearReindexTimer(file.path);
				if (!this.semanticIndex) return;
				this.semanticIndex.removeFile(file.path).catch(() => {});
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				this.clearReindexTimer(oldPath);
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
	private refreshTimer: number | null = null;

	constructor(app: App, plugin: VaultMcpPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide(): void {
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	private scheduleRefreshIfIndexing(): void {
		if (this.refreshTimer !== null) return;
		const status = this.plugin.semanticIndex?.status(
			this.plugin.settings.semantic.enabled
		);
		const indexing = status?.indexing || this.plugin.semanticProgress !== null;
		if (!indexing) return;
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			if (document.body.contains(this.containerEl)) this.display();
		}, 1000);
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

		this.scheduleRefreshIfIndexing();
	}

	private renderSemanticSection(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: "Semantic Search" });
		containerEl.createEl("p", {
			text:
				"Runs locally via TaylorAI/bge-micro-v2 (384-dim). First use downloads " +
				"the model (~22 MB) from Hugging Face. The index lives inside the plugin folder.",
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
				const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
				statusEl.createEl("p", {
					text: `Indexing: ${done}/${total} (${pct}%)`,
				});
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
