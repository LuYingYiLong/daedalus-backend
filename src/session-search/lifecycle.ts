type SessionDeletedListener = (sessionId: string) => void;

const sessionDeletedListeners: Set<SessionDeletedListener> = new Set();

export function registerSessionDeletedListener(listener: SessionDeletedListener): () => void {
	sessionDeletedListeners.add(listener);
	return (): void => { sessionDeletedListeners.delete(listener); };
}

export function notifySessionDeleted(sessionId: string): void {
	for (const listener of sessionDeletedListeners) listener(sessionId);
}
