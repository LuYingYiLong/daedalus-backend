import { pathToFileURL } from "node:url";
import {
	PLUGIN_RUNTIME_PROTOCOL_VERSION,
	parseWorkerEvent,
	type PluginHookRegistration,
	type PluginMcpRegistration,
	type PluginRuntimeContext,
	type PluginSkillRegistration,
	type PluginToolRegistration,
	type PluginWorkerMessage
} from "./worker-protocol.js";

type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

type PluginApi = {
	tools: { register(registration: Omit<PluginToolRegistration, "workflow" | "global"> & Partial<Pick<PluginToolRegistration, "workflow" | "global">>, handler: Handler): void };
	skills: { register(registration: PluginSkillRegistration): void };
	hooks: { register(registration: PluginHookRegistration, handler: Handler): void };
	mcp: { register(registration: PluginMcpRegistration, handlers?: { tools?: Record<string, Handler>; resources?: Record<string, Handler> }): void };
	context: PluginRuntimeContext;
};

const handlers = new Map<string, Handler>();
let sequence = 0;

for (const method of ["log", "info", "warn", "error", "debug"] as const) {
	console[method] = (...args: unknown[]): void => {
		process.stderr.write(`${args.map((value): string => typeof value === "string" ? value : JSON.stringify(value)).join(" ")}\n`);
	};
}

function send(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function registerHandler(kind: string, name: string, handler: Handler): void {
	const key: string = `${kind}:${name}`;
	if (handlers.has(key)) throw new Error(`Duplicate plugin handler: ${key}`);
	handlers.set(key, handler);
}

function createApi(context: PluginRuntimeContext): PluginApi {
	return {
		context,
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
		}
	};
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
		process.exitCode = 0;
		return;
	}
	if (message.type === "invoke") {
		const handler: Handler | undefined = handlers.get(`${message.kind}:${message.name}`);
		if (handler === undefined) {
			send({ type: "result", id: message.id, ok: false, error: "Plugin handler not found." });
			return;
		}
		try {
			send({ type: "result", id: message.id, ok: true, value: await handler(message.args) });
		} catch (error: unknown) {
			send({ type: "result", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}
}

let initializedContext: PluginRuntimeContext | undefined;
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string): void => {
	buffer += chunk;
	let newline: number;
	while ((newline = buffer.indexOf("\n")) >= 0) {
		const line: string = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (line.trim().length === 0) continue;
		void (async (): Promise<void> => {
			try {
				const message: PluginWorkerMessage = JSON.parse(line) as PluginWorkerMessage;
				if (message.type === "initialize") initializedContext = message.context;
				const context: PluginRuntimeContext = initializedContext ?? (message.type === "initialize" ? message.context : {
					pluginId: "unknown",
					sessionId: "unknown",
					capabilities: []
				});
				await handle(message, context);
			} catch (error: unknown) {
				send({ type: "error", message: error instanceof Error ? error.message : String(error) });
			}
		})();
	}
});
