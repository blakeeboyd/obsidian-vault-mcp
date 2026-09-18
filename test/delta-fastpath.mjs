// Check the startup fast path: does the vault-vs-meta mtime comparison
// correctly decide whether the index must be parsed?
//
// Run: node test/delta-fastpath.mjs
//
// Mirrors vaultDiffersFromMeta in src/semantic.ts. Kept as a standalone
// harness because the real method needs an Obsidian App to reach TFile.stat.
//
// On mtime precision: both sides of the comparison are Obsidian's
// file.stat.mtime, an integer millisecond value. Verified against a live
// 9,927-file index — 9,920 stored mtimes reproduce exactly as
// round(st_mtime_ns / 1e6), and the handful that don't are genuinely edited
// files. Comparing against a floor-rounded value instead (as a naive external
// script would) disagrees on ~half the vault, so do not "fix" this by
// re-deriving mtimes outside Obsidian. A file whose nanosecond mtime sits on
// an exact half-millisecond boundary can round inconsistently; the cost is
// one spurious re-embed of that file, which self-corrects.

import assert from "node:assert/strict";

function vaultDiffersFromMeta(stored, files, empty = new Map()) {
	if (!stored) return true;
	if (files.length !== Object.keys(stored).length + empty.size) return true;
	for (const file of files) {
		if (stored[file.path] === file.stat.mtime) continue;
		if (empty.get(file.path) === file.stat.mtime) continue;
		return true;
	}
	return false;
}

const f = (path, mtime) => ({ path, stat: { mtime } });

// Unchanged vault: the whole point — must not load the index.
assert.equal(
	vaultDiffersFromMeta(
		{ "a.md": 100, "b.md": 200 },
		[f("a.md", 100), f("b.md", 200)]
	),
	false,
	"identical vault and meta must report no difference"
);

// Modified file.
assert.equal(
	vaultDiffersFromMeta(
		{ "a.md": 100, "b.md": 200 },
		[f("a.md", 100), f("b.md", 201)]
	),
	true,
	"changed mtime must be detected"
);

// Added file.
assert.equal(
	vaultDiffersFromMeta({ "a.md": 100 }, [f("a.md", 100), f("b.md", 200)]),
	true,
	"added file must be detected"
);

// Removed file. Counting is what catches this: every surviving file still
// matches, so a per-file loop alone would miss it.
assert.equal(
	vaultDiffersFromMeta({ "a.md": 100, "b.md": 200 }, [f("a.md", 100)]),
	true,
	"removed file must be detected"
);

// Swap: one added, one removed. Counts match, so the loop has to catch it.
assert.equal(
	vaultDiffersFromMeta(
		{ "a.md": 100, "b.md": 200 },
		[f("a.md", 100), f("c.md", 200)]
	),
	true,
	"simultaneous add+remove must be detected despite equal counts"
);

// Pre-v2 meta has no mtime map: must fall back to loading the index.
assert.equal(
	vaultDiffersFromMeta(null, [f("a.md", 100)]),
	true,
	"missing mtime map must force a full load"
);

// Empty vault, empty meta.
assert.equal(vaultDiffersFromMeta({}, []), false, "empty vault matches empty meta");

// mtime 0 is a real value, not absence — a file stored at 0 and still 0 matches.
assert.equal(
	vaultDiffersFromMeta({ "a.md": 0 }, [f("a.md", 0)]),
	false,
	"mtime 0 must compare by value, not truthiness"
);

// A file missing from the map reads as undefined and must differ, not match.
assert.equal(
	vaultDiffersFromMeta({ "a.md": 100 }, [f("b.md", 100)]),
	true,
	"path present in vault but absent from meta must differ"
);

// --- chunkless files -------------------------------------------------------
// Frontmatter-only stubs produce no chunks, so they hold no vectors and cannot
// live in the mtime map. Without a separate record they look unindexed on every
// scan and get re-embedded forever. This was a real bug: 88 concept stubs were
// re-embedded on every single startup of this vault.

// A stub recorded as empty at its current mtime is known: no difference.
assert.equal(
	vaultDiffersFromMeta(
		{ "a.md": 100 },
		[f("a.md", 100), f("stub.md", 300)],
		new Map([["stub.md", 300]])
	),
	false,
	"a chunkless file recorded at its current mtime must count as known"
);

// The same stub edited (new mtime) must be re-read — it may now have a body.
assert.equal(
	vaultDiffersFromMeta(
		{ "a.md": 100 },
		[f("a.md", 100), f("stub.md", 301)],
		new Map([["stub.md", 300]])
	),
	true,
	"an edited chunkless file must be re-read in case it gained content"
);

// A stub that is gone from disk changes the count and must be detected.
assert.equal(
	vaultDiffersFromMeta({ "a.md": 100 }, [f("a.md", 100)], new Map([["stub.md", 300]])),
	true,
	"a deleted chunkless file must be detected"
);

// Empty map plus indexed files still behaves like the base case.
assert.equal(
	vaultDiffersFromMeta({ "a.md": 100 }, [f("a.md", 100)], new Map()),
	false,
	"empty chunkless map must not affect the unchanged case"
);

console.log("delta fast path: all checks passed");
