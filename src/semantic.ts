import { App, TFile, Notice, DataAdapter } from "obsidian";
import { buildEmbedderIframeScript } from "./embedder-iframe";

// Self-contained semantic search. Transformers.js runs inside a hidden
// iframe (loaded from a CDN via dynamic import), not in the main plugin
// context — this sidesteps Electron's hybrid node+browser environment,
// which otherwise makes transformers.js pick the node backend and fail.
// Embeddings persist to <plugin-dir>/embeddings.jsonl, one chunk per line.

const MODEL_ID = "TaylorAI/bge-micro-v2";
const EMBEDDING_DIM = 384;
const INDEX_VERSION = 1;

// Chunking parameters — tuned for typical markdown notes.
const MAX_CHUNK_CHARS = 1500;
const CHUNK_OVERLAP_CHARS = 200;
// Small notes skip chunking entirely.
const MIN_CHUNK_SPLIT_CHARS = 2000;

export interface SemanticSearchResult {
	path: string;
	score: number;
	chunkIndex: number;
	snippet: string;
}

export interface SemanticStatus {
	enabled: boolean;
	modelLoaded: boolean;
	indexLoaded: boolean;
	indexing: boolean;
	indexedFiles: number;
	totalChunks: number;
	lastIndexed: number | null;
}

interface IndexEntry {
	path: string;
	chunk: number;
	mtime: number;
	vector: Float32Array;
	// Stored so we can return readable snippets without re-reading the file.
	preview: string;
}

// On-disk record. Vector is base64-encoded Float32 bytes for compactness.
interface StoredEntry {
	p: string;
	c: number;
	m: number;
	v: string;
	s: string;
}

interface IndexMeta {
	version: number;
	model: string;
	dim: number;
	updated: number;
}

function base64FromFloat32(arr: Float32Array): string {
	const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

function float32FromBase64(b64: string): Float32Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new Float32Array(bytes.buffer);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	// Vectors are L2-normalized at embed time, so cosine = dot product.
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
}

// Strip YAML frontmatter and Obsidian-specific noise that hurts embeddings.
function cleanForEmbedding(content: string): string {
	let text = content;
	if (text.startsWith("---\n")) {
		const end = text.indexOf("\n---\n", 4);
		if (end !== -1) text = text.slice(end + 5);
	}
	// Drop HTML comments (sourcing blocks, etc.)
	text = text.replace(/<!--[\s\S]*?-->/g, "");
	// Collapse whitespace
	text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
	return text.trim();
}

export function chunkMarkdown(path: string, content: string): string[] {
	const cleaned = cleanForEmbedding(content);
	if (!cleaned) return [];

	// Prepend the file path as weak "title" context. Helps when a chunk
	// alone is ambiguous.
	const prefix = `${path}\n\n`;

	if (cleaned.length < MIN_CHUNK_SPLIT_CHARS) {
		return [prefix + cleaned];
	}

	// Split on blank lines first, then accumulate paragraphs greedily.
	const paragraphs = cleaned.split(/\n\s*\n/);
	const chunks: string[] = [];
	let current = "";
	for (const para of paragraphs) {
		const piece = para.trim();
		if (!piece) continue;
		if (current.length + piece.length + 2 > MAX_CHUNK_CHARS && current) {
			chunks.push(current);
			// Overlap: carry forward the tail of the previous chunk.
			const tail = current.slice(-CHUNK_OVERLAP_CHARS);
			current = tail + "\n\n" + piece;
		} else {
			current = current ? `${current}\n\n${piece}` : piece;
		}
	}
	if (current) chunks.push(current);
	return chunks.map((c) => prefix + c);
}

// Brief human-readable preview drawn from the chunk text (without the path prefix).
function buildPreview(chunkText: string, maxLen = 180): string {
	const body = chunkText.replace(/^[^\n]+\n\n/, ""); // drop prefix line
	const flat = body.replace(/\s+/g, " ").trim();
	return flat.length > maxLen ? flat.slice(0, maxLen) + "…" : flat;
}

const IFRAME_ID = "vault-mcp-embedder-iframe";
const LOAD_TIMEOUT_MS = 180_000; // model download + first compile can be slow
const EMBED_TIMEOUT_MS = 120_000;

interface PendingMessage {
	resolve: (value: any) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

// Runs transformers.js inside a hidden iframe. The iframe dynamically
// imports transformers.js as an ES module from jsDelivr, so nothing about
// the library ends up in the main plugin bundle. Communication is
// promise-correlated postMessage keyed on a per-instance message prefix.
class Embedder {
	private iframe: HTMLIFrameElement | null = null;
	private loading: Promise<void> | null = null;
	private loaded = false;
	private pending: Map<string, PendingMessage> = new Map();
	private messagePrefix = `vmcp_${Math.random().toString(36).slice(2, 10)}_`;
	private nextMessageId = 0;
	private listener: ((event: MessageEvent) => void) | null = null;
	private readyPromise: Promise<void> | null = null;
	private readyResolve: (() => void) | null = null;

	isReady(): boolean {
		return this.loaded;
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		if (this.loading) return this.loading;
		this.loading = this.doLoad().finally(() => {
			this.loading = null;
		});
		return this.loading;
	}

	private async doLoad(): Promise<void> {
		// Drop any stale iframe from a previous plugin load in the same session.
		const existing = document.getElementById(IFRAME_ID);
		if (existing) existing.remove();

		this.readyPromise = new Promise<void>((resolve) => {
			this.readyResolve = resolve;
		});

		this.listener = (event: MessageEvent) => this.handleMessage(event);
		window.addEventListener("message", this.listener);

		const iframe = document.createElement("iframe");
		iframe.id = IFRAME_ID;
		iframe.style.display = "none";
		// No sandbox attribute: Smart Connections' reference implementation
		// runs unsandboxed so the iframe inherits the app:// origin and
		// cross-origin ES-module imports from CDN work cleanly. A sandboxed
		// iframe gets a null origin, which CSP-blocks dynamic import of the
		// transformers.js module in some Electron builds.
		const script = buildEmbedderIframeScript(IFRAME_ID);
		iframe.srcdoc =
			'<!doctype html><html><head><meta charset="utf-8"></head>' +
			'<body><script type="module">' + script + '</script></body></html>';

		document.body.appendChild(iframe);
		this.iframe = iframe;

		// Wait for the iframe module to signal readiness. onload fires when
		// the document loads but can race the module's top-level evaluation;
		// the iframe posts a __ready__ message once its listener is wired up.
		await Promise.race([
			this.readyPromise,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Embedder iframe never signalled ready")), 10_000)
			),
		]);

		await this.sendMessage("load", { model_key: MODEL_ID }, LOAD_TIMEOUT_MS);
		this.loaded = true;
	}

	private handleMessage(event: MessageEvent): void {
		const data = event.data;
		if (!data || typeof data !== "object") return;
		if (data.iframe_id !== IFRAME_ID) return;

		// Boot handshake: iframe announces its listener is live.
		if (data.id === "__ready__") {
			this.readyResolve?.();
			return;
		}

		const id = data.id;
		if (typeof id !== "string") return;
		const entry = this.pending.get(id);
		if (!entry) return;
		this.pending.delete(id);
		clearTimeout(entry.timer);
		if (data.error) entry.reject(new Error(data.error));
		else entry.resolve(data.result);
	}

	private sendMessage<T = any>(
		method: string,
		params: any,
		timeoutMs: number
	): Promise<T> {
		const iframeWindow = this.iframe?.contentWindow;
		if (!iframeWindow) return Promise.reject(new Error("Embedder iframe not available"));
		const id = this.messagePrefix + this.nextMessageId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`Embedder ${method} timed out after ${timeoutMs}ms`));
				}
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			iframeWindow.postMessage({ id, method, params, iframe_id: IFRAME_ID }, "*");
		});
	}

	async embed(texts: string[]): Promise<Float32Array[]> {
		if (!this.loaded) throw new Error("Embedder not loaded");
		if (texts.length === 0) return [];
		const { vectors, dim } = await this.sendMessage<{
			vectors: number[][];
			dim: number;
		}>("embed_batch", { texts }, EMBED_TIMEOUT_MS);
		if (dim !== EMBEDDING_DIM) {
			throw new Error(
				`Embedder returned dim ${dim}, expected ${EMBEDDING_DIM} for ${MODEL_ID}`
			);
		}
		return vectors.map((v) => Float32Array.from(v));
	}

	async unload(): Promise<void> {
		if (this.loaded) {
			try {
				await this.sendMessage("unload", {}, 5000);
			} catch {
				// best effort
			}
		}
		if (this.listener) {
			window.removeEventListener("message", this.listener);
			this.listener = null;
		}
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new Error("Embedder unloaded"));
		}
		this.pending.clear();
		if (this.iframe) {
			this.iframe.remove();
			this.iframe = null;
		}
		this.loaded = false;
		this.readyPromise = null;
		this.readyResolve = null;
	}
}

export class SemanticIndex {
	private entries: IndexEntry[] = [];
	private byPath: Map<string, IndexEntry[]> = new Map();
	private embedder = new Embedder();
	private indexing = false;
	private indexLoaded = false;
	private lastIndexedAt: number | null = null;

	constructor(
		private app: App,
		private indexPath: string,
		private metaPath: string
	) {}

	status(enabled: boolean): SemanticStatus {
		return {
			enabled,
			modelLoaded: this.embedder.isReady(),
			indexLoaded: this.indexLoaded,
			indexing: this.indexing,
			indexedFiles: this.byPath.size,
			totalChunks: this.entries.length,
			lastIndexed: this.lastIndexedAt,
		};
	}

	private adapter(): DataAdapter {
		return this.app.vault.adapter;
	}

	async load(): Promise<void> {
		if (this.indexLoaded) return;
		const adapter = this.adapter();
		if (!(await adapter.exists(this.indexPath))) {
			this.indexLoaded = true;
			return;
		}
		try {
			const raw = await adapter.read(this.indexPath);
			for (const line of raw.split("\n")) {
				if (!line.trim()) continue;
				const obj = JSON.parse(line) as StoredEntry;
				const entry: IndexEntry = {
					path: obj.p,
					chunk: obj.c,
					mtime: obj.m,
					vector: float32FromBase64(obj.v),
					preview: obj.s || "",
				};
				this.entries.push(entry);
				const list = this.byPath.get(entry.path) || [];
				list.push(entry);
				this.byPath.set(entry.path, list);
			}
			if (await adapter.exists(this.metaPath)) {
				const meta: IndexMeta = JSON.parse(await adapter.read(this.metaPath));
				this.lastIndexedAt = meta.updated || null;
			}
			this.indexLoaded = true;
		} catch (err) {
			console.error("vault-mcp: failed to load semantic index", err);
			// Treat a corrupted index as empty; next indexFile calls will rebuild.
			this.entries = [];
			this.byPath.clear();
			this.indexLoaded = true;
		}
	}

	private async persist(): Promise<void> {
		const adapter = this.adapter();
		const lines = this.entries.map((e) => {
			const stored: StoredEntry = {
				p: e.path,
				c: e.chunk,
				m: e.mtime,
				v: base64FromFloat32(e.vector),
				s: e.preview,
			};
			return JSON.stringify(stored);
		});
		await adapter.write(this.indexPath, lines.join("\n"));
		const meta: IndexMeta = {
			version: INDEX_VERSION,
			model: MODEL_ID,
			dim: EMBEDDING_DIM,
			updated: Date.now(),
		};
		await adapter.write(this.metaPath, JSON.stringify(meta, null, 2));
		this.lastIndexedAt = meta.updated;
	}

	private removePath(path: string): void {
		if (!this.byPath.has(path)) return;
		this.entries = this.entries.filter((e) => e.path !== path);
		this.byPath.delete(path);
	}

	async ensureReady(): Promise<void> {
		await this.load();
		await this.embedder.load();
	}

	async reindexFile(file: TFile): Promise<void> {
		await this.ensureReady();
		const existing = this.byPath.get(file.path);
		if (existing && existing[0]?.mtime === file.stat.mtime) return;

		const content = await this.app.vault.cachedRead(file);
		const chunks = chunkMarkdown(file.path, content);
		if (chunks.length === 0) {
			this.removePath(file.path);
			return;
		}

		const vectors = await this.embedder.embed(chunks);
		this.removePath(file.path);
		const entries: IndexEntry[] = chunks.map((text, i) => ({
			path: file.path,
			chunk: i,
			mtime: file.stat.mtime,
			vector: vectors[i],
			preview: buildPreview(text),
		}));
		this.entries.push(...entries);
		this.byPath.set(file.path, entries);
	}

	async removeFile(path: string): Promise<void> {
		this.removePath(path);
		if (this.indexLoaded) await this.persist();
	}

	async renameFile(oldPath: string, newPath: string): Promise<void> {
		const entries = this.byPath.get(oldPath);
		if (!entries) return;
		for (const e of entries) e.path = newPath;
		this.byPath.delete(oldPath);
		this.byPath.set(newPath, entries);
		if (this.indexLoaded) await this.persist();
	}

	// Reconcile stored index with current vault state without re-embedding
	// unchanged files. Catches external edits (e.g. Synology sync) that bypass
	// Obsidian's file events, which only fire while the app is running.
	async deltaScan(
		excludedPaths: string[],
		onProgress?: (done: number, total: number) => void
	): Promise<{ added: number; updated: number; removed: number }> {
		await this.load();
		if (this.indexing) return { added: 0, updated: 0, removed: 0 };

		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => !excludedPaths.some(
				(ex) => f.path === ex || f.path.startsWith(ex + "/")
			));
		const currentPaths = new Set(files.map((f) => f.path));

		const toRemove: string[] = [];
		for (const path of this.byPath.keys()) {
			if (!currentPaths.has(path)) toRemove.push(path);
		}

		const toEmbed: TFile[] = [];
		let added = 0;
		let updated = 0;
		for (const file of files) {
			const existing = this.byPath.get(file.path);
			if (!existing) {
				toEmbed.push(file);
				added++;
			} else if (existing[0]?.mtime !== file.stat.mtime) {
				toEmbed.push(file);
				updated++;
			}
		}

		if (toRemove.length === 0 && toEmbed.length === 0) {
			return { added: 0, updated: 0, removed: 0 };
		}

		this.indexing = true;
		try {
			for (const path of toRemove) this.removePath(path);

			if (toEmbed.length > 0) {
				await this.embedder.load();
				const BATCH = 8;
				let done = 0;
				for (let i = 0; i < toEmbed.length; i += BATCH) {
					const batch = toEmbed.slice(i, i + BATCH);
					await Promise.all(batch.map((f) => this.reindexFile(f)));
					done += batch.length;
					onProgress?.(done, toEmbed.length);
					await new Promise((r) => setTimeout(r, 0));
				}
			}
			await this.persist();
			return { added, updated, removed: toRemove.length };
		} finally {
			this.indexing = false;
		}
	}

	// Rebuild index, optionally pruning entries for deleted files.
	async reindexAll(
		excludedPaths: string[],
		onProgress?: (done: number, total: number) => void
	): Promise<void> {
		if (this.indexing) throw new Error("Indexing already in progress");
		this.indexing = true;
		try {
			await this.ensureReady();
			const files = this.app.vault
				.getMarkdownFiles()
				.filter((f) => !excludedPaths.some(
					(ex) => f.path === ex || f.path.startsWith(ex + "/")
				));

			const currentPaths = new Set(files.map((f) => f.path));
			for (const path of [...this.byPath.keys()]) {
				if (!currentPaths.has(path)) this.removePath(path);
			}

			const BATCH = 8;
			let done = 0;
			for (let i = 0; i < files.length; i += BATCH) {
				const batch = files.slice(i, i + BATCH);
				await Promise.all(batch.map((f) => this.reindexFile(f)));
				done += batch.length;
				onProgress?.(done, files.length);
				// Yield to the event loop so Obsidian stays responsive.
				await new Promise((r) => setTimeout(r, 0));
			}
			await this.persist();
		} finally {
			this.indexing = false;
		}
	}

	async search(
		query: string,
		opts: {
			limit: number;
			filter?: string;
			excludedPaths: string[];
		}
	): Promise<SemanticSearchResult[]> {
		await this.ensureReady();
		if (this.entries.length === 0) return [];

		const [queryVector] = await this.embedder.embed([query]);
		const scores: SemanticSearchResult[] = [];

		for (const entry of this.entries) {
			if (opts.filter && !entry.path.startsWith(opts.filter)) continue;
			if (
				opts.excludedPaths.some(
					(ex) => entry.path === ex || entry.path.startsWith(ex + "/")
				)
			) {
				continue;
			}
			const score = cosineSimilarity(queryVector, entry.vector);
			scores.push({
				path: entry.path,
				score,
				chunkIndex: entry.chunk,
				snippet: entry.preview,
			});
		}

		scores.sort((a, b) => b.score - a.score);

		// Dedupe by path — keep best-scoring chunk per file.
		const seen = new Set<string>();
		const deduped: SemanticSearchResult[] = [];
		for (const result of scores) {
			if (seen.has(result.path)) continue;
			seen.add(result.path);
			deduped.push(result);
			if (deduped.length >= opts.limit) break;
		}
		return deduped;
	}
}
