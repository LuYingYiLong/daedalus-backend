import { readFile } from "node:fs/promises";
import { getDaedalusPath } from "../../app-paths.js";
import { writeJsonFileAtomic } from "../../json-file-store.js";
import { getPluginP2Snapshot } from "./registry.js";

const MAX_EVENTS = 1000;
const MAX_BYTES = 2 * 1024 * 1024;
type StoredEvent = {
	id: string;
	topic: string;
	publisherPluginId: string;
	sessionId?: string;
	workspaceId?: string;
	createdAt: string;
	payload: Record<string, unknown>;
};
type EventDocument = { schemaVersion: 1; events: StoredEvent[] };

let writeQueue: Promise<void> = Promise.resolve();

function containsSensitiveKey(value: unknown, depth = 0): boolean {
	if (depth > 5 || value === null || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some((item): boolean => containsSensitiveKey(item, depth + 1));
	return Object.entries(value).some(([key, child]): boolean => /(api.?key|authorization|cookie|password|secret|token|mcp.?header)/iu.test(key) || containsSensitiveKey(child, depth + 1));
}

async function readEvents(): Promise<StoredEvent[]> {
	try {
		const parsed: unknown = JSON.parse(await readFile(getDaedalusPath("plugins.events"), "utf8"));
		if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { events?: unknown }).events)) return (parsed as EventDocument).events.filter((event): event is StoredEvent => typeof event?.id === "string" && typeof event.topic === "string" && typeof event.publisherPluginId === "string" && typeof event.createdAt === "string" && typeof event.payload === "object" && event.payload !== null);
	} catch {
		// 缺少或损坏的事件日志从安全空状态启动
	}
	return [];
}

function queueWrite(mutator: (events: StoredEvent[]) => StoredEvent[]): Promise<void> {
	const operation = writeQueue.then(async (): Promise<void> => {
		const events = mutator(await readEvents());
		let bounded = events.slice(-MAX_EVENTS);
		let encoded = JSON.stringify({ schemaVersion: 1, events: bounded } satisfies EventDocument);
		while (Buffer.byteLength(encoded, "utf8") > MAX_BYTES && bounded.length > 1) {
			bounded = bounded.slice(1);
			encoded = JSON.stringify({ schemaVersion: 1, events: bounded } satisfies EventDocument);
		}
		await writeJsonFileAtomic(getDaedalusPath("plugins.events"), { schemaVersion: 1, events: bounded } satisfies EventDocument);
	});
	writeQueue = operation;
	return operation;
}

function resolveDeclaration(events: Awaited<ReturnType<typeof getPluginP2Snapshot>>["events"], pluginId: string, topic: string) {
	const namespaced = topic.startsWith("plugin:") || topic.startsWith("harness:") ? topic : `plugin:${pluginId}:${topic}`;
	return { declaration: events.find((event): boolean => event.pluginId === pluginId && event.topic === namespaced), topic: namespaced };
}

function matchesPayloadSchema(payload: Record<string, unknown>, schema: Record<string, unknown> | undefined): boolean {
	if (schema === undefined) return true;
	if (schema.type !== undefined && schema.type !== "object") return false;
	const properties = schema.properties;
	if (properties !== undefined && (typeof properties !== "object" || properties === null || Array.isArray(properties))) return false;
	if (properties !== undefined) {
		for (const [key, definition] of Object.entries(properties as Record<string, unknown>)) {
			if (definition === null || typeof definition !== "object" || Array.isArray(definition)) return false;
			const expected = (definition as { type?: unknown }).type;
			if (expected !== undefined && !["string", "number", "integer", "boolean", "object", "array", "null"].includes(String(expected))) return false;
			if (payload[key] !== undefined && expected === "string" && typeof payload[key] !== "string") return false;
			if (payload[key] !== undefined && expected === "number" && (typeof payload[key] !== "number" || !Number.isFinite(payload[key] as number))) return false;
			if (payload[key] !== undefined && expected === "integer" && (typeof payload[key] !== "number" || !Number.isInteger(payload[key] as number))) return false;
			if (payload[key] !== undefined && expected === "boolean" && typeof payload[key] !== "boolean") return false;
		}
	}
	const required = schema.required;
	if (required !== undefined && (!Array.isArray(required) || required.some((key): boolean => typeof key !== "string" || payload[key] === undefined))) return false;
	return true;
}

export async function publishPluginEvent(input: { pluginId: string; topic: string; payload: Record<string, unknown>; sessionId?: string; workspaceId?: string }): Promise<StoredEvent> {
	const declarations = (await getPluginP2Snapshot()).events;
	const resolved = resolveDeclaration(declarations, input.pluginId, input.topic);
	if (resolved.declaration?.publish !== true) throw Object.assign(new Error("Plugin is not allowed to publish this event topic."), { code: "plugin_event_publish_denied" });
	if (!matchesPayloadSchema(input.payload, resolved.declaration.payloadSchema)) throw Object.assign(new Error("Plugin event payload does not match its declared schema."), { code: "plugin_event_payload_schema_mismatch" });
	const serialized = JSON.stringify(input.payload);
	if (Buffer.byteLength(serialized, "utf8") > 32 * 1024) throw Object.assign(new Error("Plugin event payload exceeds the size limit."), { code: "plugin_event_payload_too_large" });
	if (containsSensitiveKey(input.payload)) throw Object.assign(new Error("Plugin event payload contains a sensitive field."), { code: "plugin_event_sensitive_data" });
	const event: StoredEvent = {
		id: `event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
		topic: resolved.topic,
		publisherPluginId: input.pluginId,
		...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
		...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
		createdAt: new Date().toISOString(),
		payload: input.payload
	};
	await queueWrite((events): StoredEvent[] => [...events, event]);
	return event;
}

export async function subscribePluginEvents(input: { pluginId: string; topic: string; cursor?: string }): Promise<{ events: StoredEvent[]; nextCursor: string | null; expired: boolean }> {
	const declarations = (await getPluginP2Snapshot()).events;
	const resolved = resolveDeclaration(declarations, input.pluginId, input.topic);
	if (resolved.declaration?.subscribe !== true) throw Object.assign(new Error("Plugin is not allowed to subscribe to this event topic."), { code: "plugin_event_subscribe_denied" });
	const events = (await readEvents()).filter((event): boolean => event.topic === resolved.topic);
	const firstId = events[0]?.id;
	const cursorIndex = input.cursor === undefined ? -1 : events.findIndex((event): boolean => event.id === input.cursor);
	const expired = input.cursor !== undefined && cursorIndex < 0 && firstId !== undefined;
	const result = cursorIndex < 0 ? events : events.slice(cursorIndex + 1);
	return { events: result.slice(-100), nextCursor: result.at(-1)?.id ?? input.cursor ?? null, expired };
}

export async function acknowledgePluginEvent(pluginId: string, topic: string, cursor: string): Promise<{ acknowledged: true; cursor: string }> {
	const resolved = resolveDeclaration((await getPluginP2Snapshot()).events, pluginId, topic);
	if (resolved.declaration?.subscribe !== true) throw Object.assign(new Error("Plugin is not allowed to acknowledge this event topic."), { code: "plugin_event_subscribe_denied" });
	return { acknowledged: true, cursor };
}
