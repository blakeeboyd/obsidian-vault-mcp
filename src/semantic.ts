import { App, TFile, Notice, DataAdapter } from "obsidian";

// Self-contained semantic search. Uses @huggingface/transformers to run
// Xenova/all-MiniLM-L6-v2 (384-dim) locally inside the Obsidian renderer.
// Embeddings persist to <plugin-dir>/embeddings.jsonl, one chunk per line.

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
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

type EmbeddingPipeline = (
	texts: string | string[],
	opts?: { pooling?: "mean"; normalize?: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>;

class Embedder {
	private pipeline: EmbeddingPipeline | null = null;
	private loading: Promise<void> | null = null;

	isReady(): boolean {
		return this.pipeline !== null;
	}

	async load(): Promise<void> {
		if (this.pipeline) return;
		if (this.loading) return this.loading;
		this.loading = (async () => {
			// Dynamic import: keeps ~MB of transformers code out of the initial
			// plugin load when semantic search is disabled.
			const transformers: any = await import("@huggingface/transformers");
			const env = transformers.env;
			// Use HF Hub. Models cache in the Electron renderer's storage.
			env.allowLocalModels = false;
			env.useBrowserCache = true;
			const pipe = await transformers.pipeline(
				"feature-extraction",
				MODEL_ID,
				{ dtype: "q8" }
			);
			this.pipeline = pipe as EmbeddingPipeline;
		})();
		try {
			await this.loading;
		} finally {
			this.loading = null;
		}
	}

	async embed(texts: string[]): Promise<Float32Array[]> {
		if (!this.pipeline) throw new Error("Embedder not loaded");
		if (texts.length === 0) return [];
		const output = await this.pipeline(texts, {
			pooling: "mean",
			normalize: true,
		});
		const result: Float32Array[] = [];
		for (let i = 0; i < texts.length; i++) {
			const start = i * EMBEDDING_DIM;
			result.push(output.data.slice(start, start + EMBEDDING_DIM));
		}
		return result;
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
