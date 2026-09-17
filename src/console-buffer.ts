export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

export interface ConsoleEntry {
	timestamp: number;
	level: ConsoleLevel;
	message: string;
}

export interface ConsoleReadOptions {
	levels?: ConsoleLevel[];
	filter?: string;
	limit?: number;
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
			// Circular or otherwise unserializable — String() is better than losing
			// the entry entirely.
			return String(arg);
		}
	}
	return String(arg);
}

function renderArgs(args: unknown[]): string {
	return args.map(renderArg).join(" ");
}

// Ring buffer over console output, exposed through the read_console tool so a
// plugin bug can be diagnosed over MCP without opening DevTools.
export class ConsoleBuffer {
	private entries: ConsoleEntry[] = [];
	private installed = false;

	// Saved originals so we can restore on uninstall and forward to DevTools
	// while patched. Keyed by level.
	private originals: Partial<Record<ConsoleLevel, (...args: unknown[]) => void>> = {};
	private errorHandler: ((event: ErrorEvent) => void) | null = null;
	private rejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;

	constructor(private capacity = 500) {}

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
			const detail =
				event.error instanceof Error
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

	push(level: ConsoleLevel, message: string): void {
		this.entries.push({ timestamp: Date.now(), level, message });
		if (this.entries.length > this.capacity) {
			this.entries.splice(0, this.entries.length - this.capacity);
		}
	}

	clear(): void {
		this.entries = [];
	}

	// Return buffered entries, newest last, after applying optional filters.
	read(opts: ConsoleReadOptions = {}): ConsoleEntry[] {
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
			result = result.slice(result.length - opts.limit);
		}
		return result;
	}

	size(): number {
		return this.entries.length;
	}
}
