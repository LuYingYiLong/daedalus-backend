/**
 * Source for the bridge Cordis plugin written into each isolated Harness runtime.
 * It deliberately uses plain JavaScript so a built Harness can load it without
 * resolving Daedalus' TypeScript loader.
 */
export const HARNESS_BRIDGE_MODULE_SOURCE: string = String.raw`
const tools = new Map();
const hooks = new Map();
const mcpTools = new Map();
const mcpResources = new Map();
const registry = { tools: [], skills: [], hooks: [], mcpServers: [] };
const allowedHookEvents = new Set(['SessionStart','SessionEnd','UserPromptSubmit','PreToolUse','PermissionRequest','PostToolUse','PreCompact','PostCompact','Stop']);
let initialized = false;
let inputBuffer = '';
let shuttingDown = false;
let processing = Promise.resolve();

function write(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function notify(method, params) { write({ jsonrpc: '2.0', method, params }); }
function snapshot() { return JSON.parse(JSON.stringify(registry)); }
function safeObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function safeSchema(value) { const schema = safeObject(value); return Object.keys(schema).length ? schema : { type: 'object', additionalProperties: true }; }
function riskOf(value) {
  if (value?.daedalusRisk === 'read' || value?.annotations?.readOnlyHint === true) return 'read';
  if (['verify','propose','write','destructive'].includes(value?.daedalusRisk)) return value.daedalusRisk;
  return 'write';
}
function publish() { if (initialized) notify('registry.snapshot', snapshot()); }
function uniquePush(list, value, key) { const index = list.findIndex((item) => item[key] === value[key]); if (index >= 0) list[index] = value; else list.push(value); }

function registerTool(definition) {
  if (!definition || typeof definition.name !== 'string' || typeof definition.execute !== 'function') return;
  const registration = {
    name: definition.name,
    title: typeof definition.title === 'string' ? definition.title : definition.name,
    description: typeof definition.description === 'string' ? definition.description : definition.name,
    inputSchema: safeSchema(definition.inputSchema ?? definition.parameters),
    risk: riskOf(definition), workflow: definition.workflow === true, global: definition.global === true,
  };
  tools.set(registration.name, definition.execute.bind(definition));
  uniquePush(registry.tools, registration, 'name');
  publish();
}

function createExplicitApi() {
  return {
    registerTool(registration, handler) { registerTool({ ...safeObject(registration), execute: handler }); },
    registerSkill(skill) {
      if (!skill || typeof skill.slug !== 'string' || typeof skill.body !== 'string') return;
      uniquePush(registry.skills, { slug: skill.slug, name: String(skill.name ?? skill.slug), description: String(skill.description ?? ''), body: skill.body, allowedTools: Array.isArray(skill.allowedTools) ? skill.allowedTools.filter((item) => typeof item === 'string') : [] }, 'slug');
      publish();
    },
    registerHook(registration, handler) {
      if (!registration || !allowedHookEvents.has(registration.event) || typeof handler !== 'function') return;
      const handlerName = String(registration.handlerName ?? registration.event + ':' + hooks.size);
      hooks.set(handlerName, handler);
      uniquePush(registry.hooks, { event: registration.event, matcher: registration.matcher, async: registration.async === true, failurePolicy: registration.failurePolicy === 'block' ? 'block' : 'continue', handlerName }, 'handlerName');
      publish();
    },
    registerMcp(server, handlers = {}) {
      if (!server || typeof server.serverId !== 'string') return;
      const normalized = { serverId: server.serverId, serverName: String(server.serverName ?? server.serverId), tools: Array.isArray(server.tools) ? server.tools : [], resources: Array.isArray(server.resources) ? server.resources : [] };
      for (const [name, handler] of Object.entries(handlers.tools ?? {})) if (typeof handler === 'function') mcpTools.set(normalized.serverId + ':' + name, handler);
      for (const [uri, handler] of Object.entries(handlers.resources ?? {})) if (typeof handler === 'function') mcpResources.set(normalized.serverId + ':' + uri, handler);
      uniquePush(registry.mcpServers, normalized, 'serverId');
      publish();
    },
  };
}

async function invoke(params) {
  const kind = params?.kind;
  const name = params?.name;
  const args = safeObject(params?.args);
  if (kind === 'tool') {
    const handler = tools.get(name); if (!handler) throw new Error('Harness tool is not registered.');
    return await handler(args, { signal: new AbortController().signal });
  }
  if (kind === 'hook') {
    const handler = hooks.get(name); if (!handler) throw new Error('Harness hook is not registered.');
    return await handler(args, async () => ({ kind: 'continue' }));
  }
  if (kind === 'mcp_tool') {
    const handler = mcpTools.get(name); if (!handler) throw new Error('Harness MCP tool is not registered.');
    return await handler(args);
  }
  if (kind === 'mcp_resource') {
    const handler = mcpResources.get(name); if (!handler) throw new Error('Harness MCP resource is not registered.');
    return await handler(args);
  }
  throw new Error('Unsupported Harness invocation kind.');
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.id !== 'string' || message.id.length > 128 || typeof message.method !== 'string') return;
  try {
    if (shuttingDown) throw new Error('Harness bridge is shutting down.');
    if (message.method === 'initialize') {
      if (initialized) throw new Error('Harness bridge received duplicate initialize.');
      if (message.params?.protocolVersion !== 1) throw new Error('Unsupported Daedalus Harness bridge version.');
      initialized = true;
      write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
      notify('ready', { protocolVersion: 1, registry: snapshot() });
      return;
    }
    if (!initialized) throw new Error('Harness bridge must be initialized before use.');
    if (message.method === 'health') { write({ jsonrpc: '2.0', id: message.id, result: { ready: initialized } }); return; }
    if (message.method === 'invoke') { write({ jsonrpc: '2.0', id: message.id, result: await invoke(message.params) }); return; }
    if (message.method === 'shutdown') { shuttingDown = true; write({ jsonrpc: '2.0', id: message.id, result: {} }); process.exitCode = 0; process.stdin.pause(); return; }
    throw new Error('Method not found.');
  } catch (error) {
    write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
  }
}

export const name = 'daedalus-harness-bridge';
export function apply(ctx) {
  const explicitApi = createExplicitApi();
  try { ctx.provide?.('daedalusBridge', explicitApi); } catch {}
  const toolService = ctx.tools ?? ctx.get?.('tools');
  if (toolService && typeof toolService.register === 'function') {
    const originalRegister = toolService.register.bind(toolService);
    toolService.register = function(definition, ...rest) { const disposer = originalRegister(definition, ...rest); registerTool(definition); return disposer; };
  }
  const skillService = ctx.skills ?? ctx.get?.('skills');
  if (skillService && typeof skillService.register === 'function') {
    const originalSkillRegister = skillService.register.bind(skillService);
    skillService.register = function(skill, ...rest) {
      const disposer = originalSkillRegister(skill, ...rest);
      explicitApi.registerSkill({ slug: skill.slug ?? skill.name, name: skill.name ?? skill.slug, description: skill.description ?? '', body: skill.body ?? skill.content ?? '', allowedTools: skill.allowedTools ?? [] });
      return disposer;
    };
  }
  const prototype = Object.getPrototypeOf(ctx);
  if (prototype && typeof prototype.on === 'function' && !prototype.__daedalusBridgeOn) {
    const originalOn = prototype.on;
    Object.defineProperty(prototype, '__daedalusBridgeOn', { value: true });
    prototype.on = function(event, callback, ...rest) {
      if (allowedHookEvents.has(event) && typeof callback === 'function') explicitApi.registerHook({ event }, callback.bind(this));
      return originalOn.call(this, event, callback, ...rest);
    };
  }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    inputBuffer += chunk;
    let newline;
    while ((newline = inputBuffer.indexOf('\\n')) >= 0) {
      const line = inputBuffer.slice(0, newline); inputBuffer = inputBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { processing = processing.then(() => handle(JSON.parse(line))).catch((error) => notify('log', { level: 'error', message: error instanceof Error ? error.message : String(error) })); } catch (error) { notify('log', { level: 'error', message: error instanceof Error ? error.message : String(error) }); }
    }
  });
  notify('bridge.loaded', { protocolVersion: 1 });
}
`;
