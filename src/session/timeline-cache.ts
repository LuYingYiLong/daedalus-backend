export type TimelineCacheStats = {
	entryCount: number;
	bytes: number;
	hits: number;
	evictions: number;
	skipped: number;
};

type TimelineCacheEntry<T> = {
	value: T;
	bytes: number;
	lastAccess: number;
};

const DEFAULT_MAX_BYTES: number = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES: number = 8;
const DEFAULT_MAX_ENTRY_BYTES: number = 16 * 1024 * 1024;

export class TimelineCache<T> {
	private readonly entries: Map<string, TimelineCacheEntry<T>> = new Map();

	private totalBytes: number = 0;

	private nextAccess: number = 0;

	private hits: number = 0;

	private evictions: number = 0;

	private skipped: number = 0;

	public constructor(
		private readonly maxBytes: number = DEFAULT_MAX_BYTES,
		private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
		private readonly maxEntryBytes: number = DEFAULT_MAX_ENTRY_BYTES
	) {}

	public get(key: string): T | undefined {
		const entry: TimelineCacheEntry<T> | undefined = this.entries.get(key);
		if (entry === undefined) {
			return undefined;
		}
		this.hits += 1;
		entry.lastAccess = this.nextAccess++;
		return entry.value;
	}

	public set(key: string, value: T, bytes: number): boolean {
		const safeBytes: number = Math.max(0, Math.floor(bytes));
		if (safeBytes > this.maxEntryBytes || safeBytes > this.maxBytes) {
			this.delete(key);
			this.skipped += 1;
			return false;
		}

		this.delete(key);
		this.entries.set(key, { value, bytes: safeBytes, lastAccess: this.nextAccess++ });
		this.totalBytes += safeBytes;
		this.evictUntilWithinBudget();
		return this.entries.has(key);
	}

	public delete(key: string): boolean {
		const entry: TimelineCacheEntry<T> | undefined = this.entries.get(key);
		if (entry === undefined) {
			return false;
		}
		this.entries.delete(key);
		this.totalBytes -= entry.bytes;
		return true;
	}

	public clear(): void {
		this.entries.clear();
		this.totalBytes = 0;
	}

	public stats(): TimelineCacheStats {
		return {
			entryCount: this.entries.size,
			bytes: this.totalBytes,
			hits: this.hits,
			evictions: this.evictions,
			skipped: this.skipped
		};
	}

	private evictUntilWithinBudget(): void {
		while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
			let oldestKey: string | undefined;
			let oldestAccess: number = Number.POSITIVE_INFINITY;
			for (const [key, entry] of this.entries) {
				if (entry.lastAccess < oldestAccess) {
					oldestKey = key;
					oldestAccess = entry.lastAccess;
				}
			}
			if (oldestKey === undefined) {
				return;
			}
			this.delete(oldestKey);
			this.evictions += 1;
		}
	}
}

export function estimateTimelineValueBytes(value: unknown): number {
	const visited: Set<object> = new Set();

	const estimate = (current: unknown): number => {
		if (current === null || current === undefined) {
			return 8;
		}
		if (typeof current === "string") {
			return current.length * 2;
		}
		if (typeof current === "number" || typeof current === "boolean") {
			return 8;
		}
		if (typeof current !== "object") {
			return 0;
		}
		if (visited.has(current)) {
			return 0;
		}
		visited.add(current);
		if (Array.isArray(current)) {
			return 24 + current.reduce((total: number, item: unknown): number => total + estimate(item), 0);
		}
		if (current instanceof Map) {
			let total: number = 40;
			for (const [key, item] of current) {
				total += estimate(key) + estimate(item);
			}
			return total;
		}
		if (current instanceof Set) {
			return 40 + Array.from(current).reduce((total: number, item: unknown): number => total + estimate(item), 0);
		}
		return 40 + Object.entries(current).reduce((total: number, [key, item]: [string, unknown]): number => total + key.length * 2 + estimate(item), 0);
	};

	return estimate(value);
}
