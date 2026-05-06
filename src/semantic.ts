import { App, TFile, Notice, DataAdapter, getAllTags } from "obsidian";
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

export interface RelatedNote {
	path: string;
	score: number;
	snippet: string;
	// Always set — identifies which candidate chunk drove the match.
	// Lets clients (e.g. the modal) re-derive the full chunk text via
	// chunkMarkdown without persisting the body in the index.
	chunkIndex: number;
	// Frontmatter aliases for the candidate file, if any.
	aliases?: string[];
	// One-line caption from frontmatter (summary / statement / description).
	// Replaces the chunk excerpt in clients when present — body text is a
	// noisier signal than an authored caption.
	summary?: string;
	// Targets that both source and candidate link to, capped to 5. The
	// strongest "why related" signal: it's a connection you already drew.
	sharedLinks?: string[];
	// Tags (with # prefix) carried by both files, capped to 5.
	sharedTags?: string[];
	// Whether source and candidate already link to each other directly.
	// "outgoing" = source → candidate, "incoming" = candidate → source.
	directLink?: "outgoing" | "incoming" | "bidirectional";
	// include_evidence extras — the source chunk most aligned with the
	// candidate vector, paired with the candidate's snippet.
	sourceChunkIndex?: number;
	sourceChunkText?: string;
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
	private loadingPromise: Promise<void> | null = null;
	private lastIndexedAt: number | null = null;
	// Mean-pooled, L2-renormalized note vectors for find_related_notes.
	// Computed lazily and busted whenever the underlying chunks change.
	private noteVectorCache: Map<string, Float32Array> = new Map();

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
		// Cache the in-flight promise so concurrent callers (initSemanticIndex,
		// ensureReady from reindexFile, deltaScan, modify-event reindexes)
		// share one parse pass. Without this guard, racing loads each ran the
		// full parse loop and pushed duplicate copies of every entry into
		// `this.entries`, leaving byPath correct but entries Nx bloated.
		if (this.loadingPromise) return this.loadingPromise;
		this.loadingPromise = this.doLoad().finally(() => {
			this.loadingPromise = null;
		});
		return this.loadingPromise;
	}

	private async doLoad(): Promise<void> {
		const adapter = this.adapter();
		if (!(await adapter.exists(this.indexPath))) {
			this.indexLoaded = true;
			return;
		}
		try {
			const raw = await adapter.read(this.indexPath);
			const lines = raw.split("\n");
			const YIELD_EVERY = 500;
			let skipped = 0;
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (!line.trim()) continue;
				let entry: IndexEntry;
				try {
					const obj = JSON.parse(line) as StoredEntry;
					entry = {
						path: obj.p,
						chunk: obj.c,
						mtime: obj.m,
						vector: float32FromBase64(obj.v),
						preview: obj.s || "",
					};
				} catch {
					// Skip a single corrupt line rather than dumping the whole
					// index. Corruption can come from a partial write during a
					// crash or a stray newline in a preview field. Affected
					// files will show up as missing in the next delta scan and
					// get re-embedded.
					skipped++;
					continue;
				}
				this.entries.push(entry);
				const list = this.byPath.get(entry.path) || [];
				list.push(entry);
				this.byPath.set(entry.path, list);
				// Yield to the event loop periodically. Large indexes (100k+
				// chunks) otherwise block the renderer for many seconds while
				// JSON.parse + base64 decode run synchronously.
				if (i > 0 && i % YIELD_EVERY === 0) {
					await new Promise((r) => setTimeout(r, 0));
				}
			}
			if (skipped > 0) {
				console.warn(
					`vault-mcp: skipped ${skipped} corrupt line(s) while loading semantic index`
				);
			}
			if (await adapter.exists(this.metaPath)) {
				const meta: IndexMeta = JSON.parse(await adapter.read(this.metaPath));
				this.lastIndexedAt = meta.updated || null;
			}
			// Dedupe by (path, chunk) tuple. If the on-disk index was written
			// by a buggy session (e.g. before the load-race fix), the same
			// chunk can appear N times. Collapse to the first occurrence per
			// (path, chunk) and rebuild entries from byPath as the source of
			// truth.
			this.entries = [];
			for (const [path, list] of this.byPath.entries()) {
				const seen = new Set<number>();
				const unique: IndexEntry[] = [];
				for (const e of list) {
					if (seen.has(e.chunk)) continue;
					seen.add(e.chunk);
					unique.push(e);
				}
				this.byPath.set(path, unique);
				this.entries.push(...unique);
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

	// Recovery hatch: load (which dedupes), then persist the deduped state
	// back to disk. Safe to run anytime. Returns counts so the caller can
	// report how much bloat was dropped.
	async compactAndPersist(): Promise<{
		filesIndexed: number;
		chunksBefore: number;
		chunksAfter: number;
	}> {
		const adapter = this.adapter();
		let chunksBefore = 0;
		if (await adapter.exists(this.indexPath)) {
			const raw = await adapter.read(this.indexPath);
			for (const line of raw.split("\n")) {
				if (line.trim()) chunksBefore++;
			}
		}
		await this.load();
		await this.persist();
		return {
			filesIndexed: this.byPath.size,
			chunksBefore,
			chunksAfter: this.entries.length,
		};
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
		this.noteVectorCache.delete(path);
	}

	private noteMeanVector(path: string): Float32Array | null {
		const cached = this.noteVectorCache.get(path);
		if (cached) return cached;
		const entries = this.byPath.get(path);
		if (!entries || entries.length === 0) return null;

		const dim = EMBEDDING_DIM;
		const sum = new Float32Array(dim);
		for (const entry of entries) {
			for (let i = 0; i < dim; i++) sum[i] += entry.vector[i];
		}

		// Re-normalize. Chunk vectors are L2-normalized at embed time, but
		// the average of unit vectors is not itself a unit vector, so cosine
		// would be wrong without this step.
		let norm = 0;
		for (let i = 0; i < dim; i++) norm += sum[i] * sum[i];
		norm = Math.sqrt(norm);
		if (norm === 0) return null;

		const mean = new Float32Array(dim);
		for (let i = 0; i < dim; i++) mean[i] = sum[i] / norm;

		this.noteVectorCache.set(path, mean);
		return mean;
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
		this.noteVectorCache.delete(file.path);
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
		// Move the cached vector if it exists. Same vector content, new key.
		const cached = this.noteVectorCache.get(oldPath);
		this.noteVectorCache.delete(oldPath);
		if (cached) this.noteVectorCache.set(newPath, cached);
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

	// Note-driven discovery: given a note's path, return other notes ranked
	// by mean-pooled cosine similarity. Mean pool implicitly favors atomic
	// notes; multi-topic notes will give muddier results.
	async findRelatedNotes(
		sourcePath: string,
		opts: {
			limit: number;
			filter?: string;
			excludePrefix?: string[];
			excludedPaths: string[];
			includeEvidence?: boolean;
		}
	): Promise<RelatedNote[]> {
		await this.load();
		if (this.entries.length === 0) return [];

		const sourceVec = this.noteMeanVector(sourcePath);
		if (!sourceVec) {
			throw new Error(
				`No embeddings found for ${sourcePath}. The file may not be indexed yet — try a reindex.`
			);
		}

		const candidates: { path: string; score: number; vec: Float32Array }[] = [];
		for (const path of this.byPath.keys()) {
			if (path === sourcePath) continue;
			if (opts.filter && !path.startsWith(opts.filter)) continue;
			if (opts.excludePrefix?.some((ex) => path.startsWith(ex))) continue;
			if (
				opts.excludedPaths.some(
					(ex) => path === ex || path.startsWith(ex + "/")
				)
			) {
				continue;
			}
			const vec = this.noteMeanVector(path);
			if (!vec) continue;
			candidates.push({ path, score: cosineSimilarity(sourceVec, vec), vec });
		}

		candidates.sort((a, b) => b.score - a.score);
		const top = candidates.slice(0, opts.limit);

		const sourceEntries = this.byPath.get(sourcePath) || [];
		// Compute source-side connection signals once; reuse across candidates.
		const sourceLinks = this.outgoingLinks(sourcePath);
		const sourceTags = this.fileTags(sourcePath);

		return top.map((c) => {
			const candEntries = this.byPath.get(c.path) || [];

			// Best candidate chunk wrt source vector — drives the snippet.
			let bestCandIdx = candEntries[0]?.chunk ?? 0;
			let bestCandScore = -Infinity;
			let bestCandPreview = candEntries[0]?.preview ?? "";
			for (const e of candEntries) {
				const s = cosineSimilarity(e.vector, sourceVec);
				if (s > bestCandScore) {
					bestCandScore = s;
					bestCandIdx = e.chunk;
					bestCandPreview = e.preview;
				}
			}

			const aliases = this.readAliases(c.path);
			const summary = this.readSummary(c.path);
			const candLinks = this.outgoingLinks(c.path);
			const candTags = this.fileTags(c.path);

			// Shared third-party links: targets that both source and candidate
			// link to. Exclude the source/candidate themselves so "shared"
			// means "shared third-party concept," not "they link to each other."
			const sharedLinksAll: string[] = [];
			for (const link of sourceLinks) {
				if (link === c.path || link === sourcePath) continue;
				if (candLinks.has(link)) sharedLinksAll.push(link);
			}
			const sharedTagsAll: string[] = [];
			for (const tag of sourceTags) {
				if (candTags.has(tag)) sharedTagsAll.push(tag);
			}

			// Direct link between source and candidate, if any.
			const sToC = sourceLinks.has(c.path);
			const cToS = candLinks.has(sourcePath);
			let directLink: RelatedNote["directLink"] | undefined;
			if (sToC && cToS) directLink = "bidirectional";
			else if (sToC) directLink = "outgoing";
			else if (cToS) directLink = "incoming";

			const result: RelatedNote = {
				path: c.path,
				score: c.score,
				snippet: bestCandPreview,
				chunkIndex: bestCandIdx,
			};
			if (aliases && aliases.length > 0) result.aliases = aliases;
			if (summary) result.summary = summary;
			if (sharedLinksAll.length > 0) {
				result.sharedLinks = sharedLinksAll.slice(0, 5);
			}
			if (sharedTagsAll.length > 0) {
				result.sharedTags = sharedTagsAll.slice(0, 5);
			}
			if (directLink) result.directLink = directLink;

			if (opts.includeEvidence) {
				// Best source chunk wrt candidate vector — the other half of
				// the chunk-pair "why this connects" view.
				let bestSrcIdx = sourceEntries[0]?.chunk ?? 0;
				let bestSrcScore = -Infinity;
				let bestSrcPreview = sourceEntries[0]?.preview ?? "";
				for (const e of sourceEntries) {
					const s = cosineSimilarity(e.vector, c.vec);
					if (s > bestSrcScore) {
						bestSrcScore = s;
						bestSrcIdx = e.chunk;
						bestSrcPreview = e.preview;
					}
				}
				result.sourceChunkIndex = bestSrcIdx;
				result.sourceChunkText = bestSrcPreview;
			}

			return result;
		});
	}

	private readAliases(path: string): string[] | null {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return null;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) return null;
		const raw = fm.aliases ?? fm.alias;
		if (raw === undefined || raw === null) return null;
		const list = Array.isArray(raw) ? raw : [raw];
		const aliases = list
			.map((v) => (typeof v === "string" ? v.trim() : String(v)))
			.filter((v) => v.length > 0);
		return aliases.length > 0 ? aliases : null;
	}

	// Frontmatter caption ladder. Different note conventions surface their
	// "what is this" line under different keys; check the common ones.
	private readSummary(path: string): string | undefined {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return undefined;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) return undefined;
		for (const field of ["summary", "statement", "description"]) {
			const v = fm[field];
			if (typeof v === "string" && v.trim().length > 0) {
				return v.trim();
			}
		}
		return undefined;
	}

	private outgoingLinks(path: string): Set<string> {
		const links = this.app.metadataCache.resolvedLinks[path];
		if (!links) return new Set();
		return new Set(Object.keys(links));
	}

	private fileTags(path: string): Set<string> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return new Set();
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return new Set();
		const tags = getAllTags(cache);
		return new Set(tags || []);
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
