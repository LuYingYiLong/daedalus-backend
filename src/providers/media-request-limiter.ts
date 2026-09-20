let active = 0;
const perProvider = new Map<string, number>();
const pending = new Set<() => void>();

export async function withMediaRequestLimit<T>(provider: string, signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
	while (active >= 4 || (perProvider.get(provider) ?? 0) >= 2) {
		signal.throwIfAborted();
		await new Promise<void>((resolve, reject) => {
			const wake = (): void => { pending.delete(wake); signal.removeEventListener("abort", abort); resolve(); };
			const abort = (): void => { pending.delete(wake); reject(signal.reason); };
			pending.add(wake); signal.addEventListener("abort", abort, { once: true });
		});
	}
	signal.throwIfAborted(); active++; perProvider.set(provider, (perProvider.get(provider) ?? 0) + 1);
	try { return await execute(); }
	finally { active--; perProvider.set(provider, (perProvider.get(provider) ?? 1) - 1); for (const wake of [...pending]) wake(); }
}
