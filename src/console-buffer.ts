// Ring buffer that captures console output so the MCP server can read it.
//
// Obsidian plugins run in Electron's renderer process; console.log/warn/error
// land in the DevTools console, which an MCP client cannot see. This module
// patches the four console methods at install time, mirrors every call into a
// fixed-size buffer, then forwards to the originals so DevTools still works.
// It also subscribes to uncaught errors and unhandled promise rejections,
// since those are the entries most worth surfacing when debugging.
//
// Capture begins at install() and ends at uninstall(); anything logged before
// the plugin loaded is not recoverable. The buffer is capacity-bounded, so old
// entries fall off once it fills.

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

export interface ConsoleEntry {
	// Wall-clock time the entry was captured (ms since epoch).
	timestamp: number;
	level: ConsoleLevel;
	// The console arguments rendered to a single string, the way DevTools
	// would show them. Objects are JSON-stringified; circular refs degrade
	// to String(arg) rather than throwing.
	message: string;
}

const PATCHED_METHODS: ConsoleLevel[] = ["log", "info", "warn", "error", "debug"];

function renderArg(arg: unknown): string {
	if (typeof arg === "string") return arg;
	if (arg instanceof Error) {
		return arg.stack || `${arg.name}: ${arg.message}`;
	}
	if (arg === null) return "null";
	if (arg === undefined) return "undefined";
	if (typeof arg === "object") {
		try {
			return JSON.stringify(arg);
		} catch {
			// Circular or otherwise non-serializable.
			return String(arg);
		}
	}
	return String(arg);
}

function renderArgs(args: unknown[]): string {
	return args.map(renderArg).join(" ");
}

export class ConsoleBuffer {
	private entries: ConsoleEntry[] = [];
	private installed = false;

	// Saved originals so we can restore on uninstall and forward to DevTools
	// while patched. Keyed by level.
	private originals: Partial<Record<ConsoleLevel, (...args: unknown[]) => void>> = {};

	private errorHandler: ((event: ErrorEvent) => void) | null = null;
	private rejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;

	constructor(private capacity: number = 500) {}

	install(): void {
		if (this.installed) return;
		this.installed = true;

		for (const level of PATCHED_METHODS) {
			const original = console[level] as (...args: unknown[]) => void;
			this.originals[level] = original;
			console[level] = (...args: unknown[]) => {
				this.push(level, renderArgs(args));
				original.apply(console, args);
			};
		}

		this.errorHandler = (event: ErrorEvent) => {
			const detail = event.error instanceof Error
				? event.error.stack || event.error.message
				: event.message;
			this.push("error", `Uncaught: ${detail}`);
		};
		this.rejectionHandler = (event: PromiseRejectionEvent) => {
			this.push("error", `Unhandled rejection: ${renderArg(event.reason)}`);
		};
		window.addEventListener("error", this.errorHandler);
		window.addEventListener("unhandledrejection", this.rejectionHandler);
	}

	uninstall(): void {
		if (!this.installed) return;
		this.installed = false;

		for (const level of PATCHED_METHODS) {
			const original = this.originals[level];
			if (original) console[level] = original;
		}
		this.originals = {};

		if (this.errorHandler) {
			window.removeEventListener("error", this.errorHandler);
			this.errorHandler = null;
		}
		if (this.rejectionHandler) {
			window.removeEventListener("unhandledrejection", this.rejectionHandler);
			this.rejectionHandler = null;
		}
	}

	private push(level: ConsoleLevel, message: string): void {
		this.entries.push({ timestamp: Date.now(), level, message });
		if (this.entries.length > this.capacity) {
			// Drop the oldest. Splice in a batch to avoid shift() churn if the
			// buffer somehow overshoots (e.g. capacity lowered at runtime).
			this.entries.splice(0, this.entries.length - this.capacity);
		}
	}

	clear(): void {
		this.entries = [];
	}

	// Return buffered entries, newest last, after applying optional filters.
	read(opts: {
		levels?: ConsoleLevel[];
		filter?: string;
		limit?: number;
	} = {}): ConsoleEntry[] {
		let result = this.entries;
		if (opts.levels && opts.levels.length > 0) {
			const set = new Set(opts.levels);
			result = result.filter((e) => set.has(e.level));
		}
		if (opts.filter) {
			const needle = opts.filter.toLowerCase();
			result = result.filter((e) => e.message.toLowerCase().includes(needle));
		}
		if (opts.limit !== undefined && opts.limit >= 0 && result.length > opts.limit) {
			// Keep the most recent `limit` entries.
			result = result.slice(result.length - opts.limit);
		}
		return result;
	}

	size(): number {
		return this.entries.length;
	}
}
