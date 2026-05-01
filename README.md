# Vault MCP

An Obsidian plugin that exposes vault file operations and semantic search over [MCP](https://modelcontextprotocol.io/) (Model Context Protocol). Designed for Claude Code, but works with any MCP client.

Two things this plugin gets right that shell-level tools don't:

1. When files are renamed or moved through this plugin, Obsidian automatically updates all internal `[[wikilinks]]`.
2. Semantic search runs locally inside the plugin. No Smart Connections, no cloud API, no separate daemon.

## Tools

### File operations

| Tool | Description |
|------|-------------|
| `rename_file` | Rename or move a file/folder with automatic link updating |
| `create_folder` | Create a folder (parents included) |
| `delete_file` | Delete respecting Obsidian trash preferences |
| `list_files` | List vault files with optional prefix filter |
| `read_file` | Read file contents |
| `write_file` | Write or create a file |

### Search and query

| Tool | Description |
|------|-------------|
| `find_backlinks` | All files linking to a given path |
| `search_vault` | Full-text search across markdown files |
| `query_frontmatter` | Find files by frontmatter field value |
| `find_broken_links` | Wikilinks pointing nowhere |
| `query_by_tag` | Files with a given tag (frontmatter or inline) |
| `semantic_search` | Local-embedding semantic search (see below) |

### Edit and quality of life

| Tool | Description |
|------|-------------|
| `update_frontmatter` | Set or remove a single frontmatter field |
| `search_replace` | Find/replace across files, with regex and dry-run |
| `patch_content` | Insert/replace content at a marker or heading |
| `open_file` | Open a file in the Obsidian editor |
| `get_vault_info` | Return vault name and path (useful for multi-vault setups) |

### Templater (optional)

| Tool | Description |
|------|-------------|
| `list_templates` | List available Templater templates |
| `create_from_template` | Create a file using a Templater template |

## Semantic search

The `semantic_search` tool finds notes by meaning rather than keyword match. It runs locally. Embeddings are computed in a hidden iframe inside Obsidian and stored in the plugin folder.

### How it works

- **Model:** `TaylorAI/bge-micro-v2`, a 384-dimensional sentence encoder. Quantized ONNX (~22 MB). Loaded via [`@huggingface/transformers`](https://github.com/huggingface/transformers.js) running ONNX Runtime Web on WASM.
- **First use:** transformers.js and the model are pulled from the jsDelivr and Hugging Face CDNs respectively, then cached by Obsidian's renderer. Subsequent sessions load from cache with no network needed.
- **Chunking:** each markdown file is stripped of frontmatter and HTML comments, then split on blank lines into chunks of up to ~1,500 characters (with ~200-character overlap). Very short notes are kept as a single chunk. Every chunk is prefixed with the file path so the embedding has weak title context when the chunk alone is ambiguous.
- **Embedding:** files are processed 8 at a time in parallel. Each chunk is tokenized, truncated to 510 BPE tokens if needed, embedded one at a time inside the iframe, mean-pooled, and L2-normalized. Because vectors are normalized, cosine similarity reduces to a dot product at query time.
- **Storage:** vectors live in `.obsidian/plugins/obsidian-vault-mcp/embeddings.jsonl`, one JSON Lines entry per chunk. Vectors are base64-encoded `Float32Array` bytes for compactness (~2 KB per chunk). A companion `embeddings-meta.json` records model, dimension, and last-updated timestamp.
- **Incremental:** on plugin load, a delta scan reconciles the stored index against the current vault: new and modified files are embedded, dropped files are removed. A full `reindexAll` checks mtimes the same way and only re-embeds what has changed.
- **Query:** the query string is embedded, scored against every stored chunk, sorted, then deduplicated by path so each file appears at most once with its best-scoring chunk.

### Enabling it

Semantic search is **off by default** so users who never touch it don't pay the model-download cost.

1. Open Obsidian Settings → Vault MCP.
2. Under **Semantic Search**, toggle **Enable semantic search** on.
3. Click **Reindex**. First run downloads the model, then embeds every markdown file in the vault. Progress is shown in the settings panel and as notices.
4. Subsequent runs are incremental. Only changed files are re-embedded.

**Auto-reindex on modify** is a separate toggle, off by default. When on, modify and create events schedule a per-file re-embed with a 15-second trailing debounce so editing bursts don't trigger an embed on every save. Renames and deletes cancel any pending timer. Turn it off if you prefer to control reindex timing yourself with the Reindex button.

### Commands

Three commands are available in the Obsidian command palette:

- **Semantic search: reindex vault.** Full incremental rebuild.
- **Semantic search: clear index.** Delete `embeddings.jsonl` and the meta file.
- **Semantic search: compact index (dedupe and rewrite).** Reload from disk (which deduplicates by `(path, chunk)` tuple) and persist back. Useful as a recovery hatch if a buggy session ever leaves duplicates in the index file.

### Why not Smart Connections?

The old version of this plugin called into the Smart Connections plugin to answer semantic queries. That coupling was fragile: it depended on Smart Connections being installed, enabled, and finished indexing. This version carries its own model and index. One plugin, one dependency surface.

## Multi-vault use

The plugin supports running in several vaults at the same time.

- **Port auto-increment** is on by default. If the configured port (27182) is in use, the plugin tries the next few ports and saves whichever one it binds. The settings panel shows the active port.
- **Per-vault server name.** The MCP `initialize` response advertises the server as `obsidian-vault-mcp (<vault name>)` so MCP clients can tell instances apart in logs.
- **`get_vault_info` tool** returns `{ name, path, file_count }` for the serving vault. Handy for confirming which vault a connection is pointed at.
- **Settings panel** shows the current vault name and generates a `claude mcp add` command with a vault-specific connection name (e.g., `vault-etchedinterim`).

Each vault needs its own MCP registration in Claude Code:

```bash
claude mcp add --transport http vault-etchedinterim http://localhost:27182/mcp
claude mcp add --transport http vault-personal http://localhost:27183/mcp
```

## Development

This project is developed outside the vault. Build output is copied into one or more vault plugin folders via an install script.

### Layout

```
obsidian-mcp/              ← dev folder (this repo)
├── src/                   ← TypeScript source
│   ├── main.ts            ← plugin lifecycle + settings UI
│   ├── server.ts          ← HTTP server (JSON-RPC over POST /mcp)
│   ├── handlers.ts        ← MCP method dispatch
│   ├── tools.ts           ← tool definitions + handlers
│   ├── semantic.ts        ← local embedding index
│   └── types.ts           ← settings and JSON-RPC types
├── scripts/install.mjs    ← copies dist/main.js + manifest.json to target vaults
├── esbuild.config.mjs     ← builds to dist/main.js
├── install-targets.json   ← gitignored, lists target vault plugin folders
└── manifest.json
```

### Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | esbuild watch mode; writes to `dist/main.js`. Use alongside `npm run install-plugin` to redeploy. |
| `npm run build` | Type-check (`tsc -noEmit`) then produce a production bundle in `dist/main.js`. |
| `npm run install-plugin` | Copy `dist/main.js` and `manifest.json` into every folder listed in `install-targets.json`. |
| `npm run deploy` | Build and install in one step. |

### Adding a target vault

Copy `install-targets.example.json` to `install-targets.json` and edit:

```json
{
	"targets": [
		"/Users/you/Documents/Obsidian/VaultA/.obsidian/plugins/obsidian-vault-mcp",
		"/Users/you/Documents/Obsidian/VaultB/.obsidian/plugins/obsidian-vault-mcp"
	]
}
```

Then `npm run deploy`. Each target folder is created if it doesn't exist.

### First-time setup

```bash
git clone <this repo>
cd obsidian-mcp
npm install
cp install-targets.example.json install-targets.json
# edit install-targets.json
npm run deploy
```

Reload the plugin in Obsidian (Settings → Community plugins → toggle off and on). Or just restart Obsidian.

## Connecting from Claude Code

After the plugin is running in a vault:

```bash
claude mcp add --transport http obsidian-vault http://localhost:27182/mcp
```

Project-scoped (only active when Claude Code is run from that directory):

```bash
cd /path/to/vault
claude mcp add --transport http --scope project obsidian-vault http://localhost:27182/mcp
```

## Architecture notes

### Server

A plain Node `http` server on `127.0.0.1`. Accepts `POST /mcp` with a JSON-RPC 2.0 body. Supports `initialize`, `tools/list`, `tools/call`, and `ping`. CORS is open (`*`) because the client is always local. Network egress is blocked by binding to loopback.

### Tool dispatch

`handleMcpRequest` builds a `ToolContext` with the `App`, excluded paths, and the optional `SemanticIndex`, then calls into the per-tool handler by name. Tools that don't need the semantic index just ignore it.

### Semantic index lifecycle

- Lazy-initialized on plugin load if `settings.semantic.enabled` is true. The first parse is gated behind `workspace.onLayoutReady` so it doesn't compete with Obsidian's startup.
- The stored index loads through a cached promise so concurrent callers (initial load, delta scan, ensureReady from auto-reindex) share one parse pass. Without this guard, racing loads would each push a fresh copy of every entry into memory.
- Parse yields to the event loop every 500 lines so large indexes don't block the renderer.
- After parse, entries are deduped by `(path, chunk)` tuple as a backstop against any pre-existing bloat on disk.
- File events: `modify` and `create` schedule a per-file debounced reindex; `delete` cancels any pending timer and removes the file's chunks; `rename` cancels the old-path timer and updates the in-memory paths.
- Persist runs at the end of a full reindex, after a delta scan that did work, and inside delete or rename events. Debounced auto-reindexes update memory without writing to disk. The next full reindex or the **Compact index** command persists them.

## License

MIT. See [LICENSE](LICENSE).
