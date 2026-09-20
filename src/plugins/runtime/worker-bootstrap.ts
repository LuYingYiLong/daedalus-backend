import { pathToFileURL } from "node:url";
import {
	PLUGIN_RUNTIME_PROTOCOL_VERSION,
	parseWorkerMessage,
	type PluginCommandRegistration,
	type PluginHookRegistration,
	type PluginFlowNodeRegistration,
	type PluginMcpRegistration,
	type PluginRuntimeContext,
	type PluginSkillRegistration,
	type PluginToolRegistration,
	type PluginWorkerMessage
} from "./worker-protocol.js";

type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;
type HostRequestState = { resolve: (value: unknown) => void; reject: (error: Error) => void; invocationId: string };

type PluginApi = {
	commands: { register(registration: Omit<PluginCommandRegistration, "handlerName"> & { handlerName?: string }, handler: Handler): void };
	tools: { register(registration: Omit<PluginToolRegistration, "workflow" | "global"> & Partial<Pick<PluginToolRegistration, "workflow" | "global">>, handler: Handler): void };
	skills: { register(registration: PluginSkillRegistration): void };
	hooks: { register(registration: PluginHookRegistration, handler: Handler): void };
	mcp: { register(registration: PluginMcpRegistration, handlers?: { tools?: Record<string, Handler>; resources?: Record<string, Handler> }): void };
	flowNodes: { register(registration: Omit<PluginFlowNodeRegistration, "handlerName"> & { handlerName?: string }, handler: Handler): void };
	context: PluginRuntimeContext;
};

const handlers = new Map<string, Handler>();
const invocationControllers = new Map<string, AbortController>();
const hostRequests = new Map<string, HostRequestState>();
let sequence = 0;

for (const method of ["log", "info", "warn", "error", "debug"] as const) {
	console[method] = (...args: unknown[]): void => {
		process.stderr.write(`${args.map((value): string => typeof value === "string" ? value : JSON.stringify(value)).join(" ")}\n`);
	};
}

function send(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function debugWorker(message: string): void {
	if (process.env.DAEDALUS_PLUGIN_DEBUG === "1") process.stderr.write(`[plugin-worker] ${message}\n`);
}

process.on("uncaughtException", (error: unknown): void => {
	debugWorker(`uncaught exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
});
process.on("unhandledRejection", (reason: unknown): void => {
	debugWorker(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});

function registerHandler(kind: string, name: string, handler: Handler): void {
	const key: string = `${kind}:${name}`;
	if (handlers.has(key)) throw new Error(`Duplicate plugin handler: ${key}`);
	handlers.set(key, handler);
}

function createApi(context: PluginRuntimeContext): PluginApi {
	return {
		context,
		commands: {
			register(registration, handler): void {
				const handlerName = registration.handlerName ?? `command:${registration.id}:${sequence++}`;
				registerHandler("command", handlerName, handler);
				send({ type: "register.command", registration: { ...registration, handlerName } });
			}
		},
		tools: {
			register(registration, handler): void {
				const normalized: PluginToolRegistration = {
					...registration,
					workflow: registration.workflow === true,
					global: registration.global === true
				};
				registerHandler("tool", normalized.name, handler);
				send({ type: "register.tool", registration: normalized });
			}
		},
		skills: {
			register(registration): void {
				send({ type: "register.skill", registration });
			}
		},
		hooks: {
			register(registration, handler): void {
				const handlerName: string = `${registration.event}:${registration.matcher ?? "*"}:${sequence++}`;
				registerHandler("hook", handlerName, handler);
				send({ type: "register.hook", registration: { ...registration, handlerName } });
			}
		},
		mcp: {
			register(registration, handlersByName = {}): void {
				for (const [name, handler] of Object.entries(handlersByName.tools ?? {})) registerHandler("mcp_tool", `${registration.serverId}:${name}`, handler);
				for (const [uri, handler] of Object.entries(handlersByName.resources ?? {})) registerHandler("mcp_resource", `${registration.serverId}:${uri}`, handler);
				send({ type: "register.mcp", registration });
			}
		},
		flowNodes: {
			register(registration, handler): void {
				const handlerName = registration.handlerName ?? `flow-node:${registration.typeId}:${sequence++}`;
				registerHandler("flow_node", handlerName, handler);
				send({ type: "register.flowNode", registration: { ...registration, handlerName } });
			}
		},
	};
}

function callHostTool(context: PluginRuntimeContext, invocationId: string, name: string, args: Record<string, unknown>, method: "tool.call" | "media.process" = "tool.call"): Promise<unknown> {
	if (!context.capabilities.includes(method === "media.process" ? "flowMedia" : "flowHostTools")) throw new Error("Plugin did not declare the flowHostTools capability.");
	if (hostRequests.size >= 64) throw new Error("Plugin host request limit reached.");
	const requestId = `host-${invocationId}-${sequence++}`;
	return new Promise((resolve, reject): void => {
		hostRequests.set(requestId, { resolve, reject, invocationId });
		send({ type: "host.request", requestId, invocationId, method, params: { name, args } });
	});
}

async function handle(message: PluginWorkerMessage, context: PluginRuntimeContext): Promise<void> {
	if (message.type === "initialize") {
		if (message.protocolVersion !== PLUGIN_RUNTIME_PROTOCOL_VERSION) throw new Error("Unsupported plugin protocol version.");
		const moduleValue: Record<string, unknown> = await import(pathToFileURL(message.entry).href) as Record<string, unknown>;
		if (typeof moduleValue.register !== "function") throw new Error("Plugin entry must export register(api).");
		await (moduleValue.register as (api: PluginApi) => unknown)(createApi(context));
		send({ type: "ready", protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION });
		return;
	}
	if (message.type === "shutdown") {
		for (const controller of invocationControllers.values()) controller.abort();
		for (const request of hostRequests.values()) request.reject(new Error("Plugin worker is shutting down."));
		hostRequests.clear();
		process.exitCode = 0;
		return;
	}
	if (message.type === "cancel") {
		invocationControllers.get(message.id)?.abort();
		for (const [requestId, request] of hostRequests) if (request.invocationId === message.id) {
			request.reject(new Error("Plugin call was cancelled."));
			hostRequests.delete(requestId);
		}
		return;
	}
	if (message.type === "host.response") {
		const request = hostRequests.get(message.requestId);
		if (request === undefined) throw new Error("Plugin worker received an unknown host response ID.");
		hostRequests.delete(message.requestId);
		if (message.ok) request.resolve(message.value);
		else request.reject(new Error(message.error ?? "Host capability request failed."));
		return;
	}
	if (message.type === "invoke") {
		const handler: Handler | undefined = handlers.get(`${message.kind}:${message.name}`);
		if (handler === undefined) {
			send({ type: "result", id: message.id, ok: false, error: "Plugin handler not found." });
			return;
		}
		const controller = new AbortController();
		invocationControllers.set(message.id, controller);
		try {
			const args = message.kind === "flow_node" ? {
				...message.args,
				signal: controller.signal,
				host: { processImage: (artifactId: string, operation: Record<string, unknown>): Promise<unknown> => callHostTool(context, message.id, "image.transform", { artifactId, operation }, "media.process"), callTool: (name: string, toolArgs: Record<string, unknown>): Promise<unknown> => callHostTool(context, message.id, name, toolArgs) },
			} : message.args;
			send({ type: "result", id: message.id, ok: true, value: await handler(args) });
		} catch (error: unknown) {
			send({ type: "result", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
		} finally {
			invocationControllers.delete(message.id);
		}
	}
}

let initializedContext: PluginRuntimeContext | undefined;
let initialized: boolean = false;
let shuttingDown: boolean = false;
let processing: Promise<void> = Promise.resolve();
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("error", (error: Error): void => debugWorker(`stdin error: ${error.stack ?? error.message}`));
process.stdout.on("error", (error: Error): void => debugWorker(`stdout error: ${error.stack ?? error.message}`));
process.stdin.on("data", (chunk: string): void => {
	debugWorker(`received ${Buffer.byteLength(chunk, "utf8")} bytes`);
	buffer += chunk;
	let newline: number;
	while ((newline = buffer.indexOf("\n")) >= 0) {
		const line: string = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (line.trim().length === 0) continue;
		processing = processing.then(async (): Promise<void> => {
			try {
				const message: PluginWorkerMessage = parseWorkerMessage(line);
				debugWorker(`handling ${message.type}`);
				if (shuttingDown) throw new Error("Plugin worker is shutting down.");
				if (message.type === "initialize") {
					if (initialized) throw new Error("Plugin worker received duplicate initialize.");
					initialized = true;
					initializedContext = message.context;
				}
				if (!initialized && message.type !== "initialize") throw new Error("Plugin worker must be initialized before use.");
				if (initializedContext === undefined) throw new Error("Plugin worker context is unavailable.");
				const context: PluginRuntimeContext = initializedContext;
				if (message.type === "invoke") {
					// Invocation work runs concurrently so a later cancel message is not
					// blocked behind the handler it needs to abort.
					void handle(message, context).then(
						(): void => debugWorker(`handled ${message.type}`),
						(error: unknown): void => send({ type: "error", message: error instanceof Error ? error.message : String(error) }),
					);
					return;
				}
				await handle(message, context);
				debugWorker(`handled ${message.type}`);
				if (message.type === "shutdown") shuttingDown = true;
			} catch (error: unknown) {
				send({ type: "error", message: error instanceof Error ? error.message : String(error) });
			}
		}).catch((error: unknown): void => send({ type: "error", message: error instanceof Error ? error.message : String(error) }));
	}
});
