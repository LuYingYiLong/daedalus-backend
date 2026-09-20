import { pathToFileURL } from "node:url";
import {
  PLUGIN_RUNTIME_PROTOCOL_VERSION,
  parseWorkerMessage
} from "./worker-protocol.js";
const handlers = /* @__PURE__ */ new Map();
const invocationControllers = /* @__PURE__ */ new Map();
const hostRequests = /* @__PURE__ */ new Map();
let sequence = 0;
for (const method of ["log", "info", "warn", "error", "debug"]) {
  console[method] = (...args) => {
    process.stderr.write(`${args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ")}
`);
  };
}
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}
`);
}
function debugWorker(message) {
  if (process.env.DAEDALUS_PLUGIN_DEBUG === "1") process.stderr.write(`[plugin-worker] ${message}
`);
}
process.on("uncaughtException", (error) => {
  debugWorker(`uncaught exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
});
process.on("unhandledRejection", (reason) => {
  debugWorker(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});
function registerHandler(kind, name, handler) {
  const key = `${kind}:${name}`;
  if (handlers.has(key)) throw new Error(`Duplicate plugin handler: ${key}`);
  handlers.set(key, handler);
}
function createApi(context) {
  return {
    context,
    commands: {
      register(registration, handler) {
        const handlerName = registration.handlerName ?? `command:${registration.id}:${sequence++}`;
        registerHandler("command", handlerName, handler);
        send({ type: "register.command", registration: { ...registration, handlerName } });
      }
    },
    tools: {
      register(registration, handler) {
        const normalized = {
          ...registration,
          workflow: registration.workflow === true,
          global: registration.global === true
        };
        registerHandler("tool", normalized.name, handler);
        send({ type: "register.tool", registration: normalized });
      }
    },
    skills: {
      register(registration) {
        send({ type: "register.skill", registration });
      }
    },
    hooks: {
      register(registration, handler) {
        const handlerName = `${registration.event}:${registration.matcher ?? "*"}:${sequence++}`;
        registerHandler("hook", handlerName, handler);
        send({ type: "register.hook", registration: { ...registration, handlerName } });
      }
    },
    mcp: {
      register(registration, handlersByName = {}) {
        for (const [name, handler] of Object.entries(handlersByName.tools ?? {})) registerHandler("mcp_tool", `${registration.serverId}:${name}`, handler);
        for (const [uri, handler] of Object.entries(handlersByName.resources ?? {})) registerHandler("mcp_resource", `${registration.serverId}:${uri}`, handler);
        send({ type: "register.mcp", registration });
      }
    },
    flowNodes: {
      register(registration, handler) {
        const handlerName = registration.handlerName ?? `flow-node:${registration.typeId}:${sequence++}`;
        registerHandler("flow_node", handlerName, handler);
        send({ type: "register.flowNode", registration: { ...registration, handlerName } });
      }
    }
  };
}
function callHostTool(context, invocationId, name, args, method = "tool.call") {
  if (!context.capabilities.includes(method === "media.process" ? "flowMedia" : "flowHostTools")) throw new Error("Plugin did not declare the flowHostTools capability.");
  if (hostRequests.size >= 64) throw new Error("Plugin host request limit reached.");
  const requestId = `host-${invocationId}-${sequence++}`;
  return new Promise((resolve, reject) => {
    hostRequests.set(requestId, { resolve, reject, invocationId });
    send({ type: "host.request", requestId, invocationId, method, params: { name, args } });
  });
}
async function handle(message, context) {
  if (message.type === "initialize") {
    if (message.protocolVersion !== PLUGIN_RUNTIME_PROTOCOL_VERSION) throw new Error("Unsupported plugin protocol version.");
    const moduleValue = await import(pathToFileURL(message.entry).href);
    if (typeof moduleValue.register !== "function") throw new Error("Plugin entry must export register(api).");
    await moduleValue.register(createApi(context));
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
    if (request === void 0) throw new Error("Plugin worker received an unknown host response ID.");
    hostRequests.delete(message.requestId);
    if (message.ok) request.resolve(message.value);
    else request.reject(new Error(message.error ?? "Host capability request failed."));
    return;
  }
  if (message.type === "invoke") {
    const handler = handlers.get(`${message.kind}:${message.name}`);
    if (handler === void 0) {
      send({ type: "result", id: message.id, ok: false, error: "Plugin handler not found." });
      return;
    }
    const controller = new AbortController();
    invocationControllers.set(message.id, controller);
    try {
      const args = message.kind === "flow_node" ? {
        ...message.args,
        signal: controller.signal,
        host: { processImage: (artifactId, operation) => callHostTool(context, message.id, "image.transform", { artifactId, operation }, "media.process"), callTool: (name, toolArgs) => callHostTool(context, message.id, name, toolArgs) }
      } : message.args;
      send({ type: "result", id: message.id, ok: true, value: await handler(args) });
    } catch (error) {
      send({ type: "result", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      invocationControllers.delete(message.id);
    }
  }
}
let initializedContext;
let initialized = false;
let shuttingDown = false;
let processing = Promise.resolve();
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("error", (error) => debugWorker(`stdin error: ${error.stack ?? error.message}`));
process.stdout.on("error", (error) => debugWorker(`stdout error: ${error.stack ?? error.message}`));
process.stdin.on("data", (chunk) => {
  debugWorker(`received ${Buffer.byteLength(chunk, "utf8")} bytes`);
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim().length === 0) continue;
    processing = processing.then(async () => {
      try {
        const message = parseWorkerMessage(line);
        debugWorker(`handling ${message.type}`);
        if (shuttingDown) throw new Error("Plugin worker is shutting down.");
        if (message.type === "initialize") {
          if (initialized) throw new Error("Plugin worker received duplicate initialize.");
          initialized = true;
          initializedContext = message.context;
        }
        if (!initialized && message.type !== "initialize") throw new Error("Plugin worker must be initialized before use.");
        if (initializedContext === void 0) throw new Error("Plugin worker context is unavailable.");
        const context = initializedContext;
        if (message.type === "invoke") {
          void handle(message, context).then(
            () => debugWorker(`handled ${message.type}`),
            (error) => send({ type: "error", message: error instanceof Error ? error.message : String(error) })
          );
          return;
        }
        await handle(message, context);
        debugWorker(`handled ${message.type}`);
        if (message.type === "shutdown") shuttingDown = true;
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }).catch((error) => send({ type: "error", message: error instanceof Error ? error.message : String(error) }));
  }
});
