const compressionTasks: Map<string, Promise<unknown>> = new Map();

export async function runContextCompressionSingleFlight<T>(
	sessionId: string,
	task: () => Promise<T>
): Promise<T> {
	const existing: Promise<unknown> | undefined = compressionTasks.get(sessionId);
	if (existing !== undefined) {
		return existing as Promise<T>;
	}
	const running: Promise<T> = task();
	compressionTasks.set(sessionId, running);
	try {
		return await running;
	} finally {
		if (compressionTasks.get(sessionId) === running) {
			compressionTasks.delete(sessionId);
		}
	}
}

export function isContextCompressionRunning(sessionId: string): boolean {
	return compressionTasks.has(sessionId);
}
