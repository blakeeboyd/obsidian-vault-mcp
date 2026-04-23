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

The `semantic_search` tool finds notes by meaning rather than keyword match. It runs locally — embeddings are computed in the plugin's own process and stored inside the plugin folder.

### How it works

- **Model:** `Xenova/all-MiniLM-L6-v2`, a 384-dimensional English-primarily sentence encoder. Quantized ONNX (~25 MB). Loaded through [`@huggingface/transformers`](https://github.com/huggingface/transformers.js), which runs ONNX Runtime Web under the hood.
- **First use:** the model is downloaded from the Hugging Face CDN and cached by Obsidian's renderer. Subsequent sessions load from cache with no network needed.
- **Chunking:** each markdown file is stripped of frontmatter and HTML comments, then split on blank lines into chunks of up to ~1,500 characters (with ~200-character overlap). Very short notes are kept as a single chunk. Every chunk is prefixed with the file path so the embedding has weak title context when the chunk alone is ambiguous.
- **Embedding:** chunks are embedded in batches of 8, with mean pooling and L2 normalization. Because vectors are normalized, cosine similarity reduces to a dot product at query time.
- **Storage:** vectors live in `.obsidian/plugins/obsidian-vault-mcp/embeddings.jsonl`, one JSON Lines entry per chunk. Vectors are base64-encoded `Float32Array` bytes for compactness (~2 KB per chunk). A companion `embeddings-meta.json` records model, dimension, and last-updated timestamp.
- **Incremental:** `reindexAll` checks each file's mtime against the stored entry and only re-embeds changed files. Deleted files are pruned. Renames are handled by the file-event listener.
- **Query:** the query string is embedded, scored against every stored chunk, sorted, then deduplicated by path so each file appears at most once with its best-scoring chunk.

### Enabling it

Semantic search is **off by default** so users who never touch it don't pay the model-download cost.

1. Open Obsidian Settings → Vault MCP.
2. Under **Semantic Search**, toggle **Enable semantic search** on.
3. Click **Reindex**. First run downloads the model, then embeds every markdown file in the vault. Progress is shown in the settings panel and as notices.
4. Subsequent runs are incremental — only changed files are re-embedded.

Auto-reindex on modify is a separate toggle, off by default. Leave it off if you edit many files at once; use the Reindex button when you want a fresh index. Turn it on if you want always-current results and don't mind a small delay on save.

### Why not Smart Connections?

The old version of this plugin called into the Smart Connections plugin to answer semantic queries. That coupling was fragile: it depended on Smart Connections being installed, enabled, and finished indexing. This version carries its own model and index. One plugin, one dependency surface.

## Multi-vault use

The plugin now supports running in several vaults at the same time.

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

A plain Node `http` server on `127.0.0.1`. Accepts `POST /mcp` with a JSON-RPC 2.0 body. Supports `initialize`, `tools/list`, `tools/call`, and `ping`. CORS is open (`*`) because the client is always local — network egress is blocked by binding to loopback.

### Tool dispatch

`handleMcpRequest` builds a `ToolContext` with the `App`, excluded paths, and the optional `SemanticIndex`, then calls into the per-tool handler by name. Tools that don't need the semantic index just ignore it.

### Semantic index lifecycle

- Lazy-initialized on plugin load if `settings.semantic.enabled` is true.
- Model and stored index both load on first call that needs them.
- File events (`modify`, `delete`, `rename`) update the in-memory index. Modify events only re-embed if `autoReindex` is on.
- Persist happens at the end of a full reindex and after delete/rename events. Individual `modify` events keep edits in memory until the next full reindex for speed.
