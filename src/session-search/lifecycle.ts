type SessionDeletedListener = (sessionId: string) => void | Promise<void>;

const sessionDeletedListeners: Set<SessionDeletedListener> = new Set();

export function registerSessionDeletedListener(listener: SessionDeletedListener): () => void {
	sessionDeletedListeners.add(listener);
	return (): void => { sessionDeletedListeners.delete(listener); };
}

export async function notifySessionDeleted(sessionId: string): Promise<void> {
	await Promise.all([...sessionDeletedListeners].map((listener): void | Promise<void> => listener(sessionId)));
}
