import { z, type ZodType } from "zod";
import { flowDocumentNodeConfigSchemas } from "../protocol/schema.js";
import type { FlowDocumentNode, FlowNodeTypeId, FlowNodePortDefinition, FlowNodeTypeDefinition } from "../protocol/types.js";

export type FlowNodeDefinitionRegistration = FlowNodeTypeDefinition & {
	parseConfig?: ((value: Record<string, unknown>) => Record<string, unknown>) | undefined;
	resolvePorts?: ((config: Record<string, unknown>) => FlowNodePortDefinition[]) | undefined;
};

type RegisteredDefinition = FlowNodeTypeDefinition & {
	parseConfig: (value: Record<string, unknown>) => Record<string, unknown>;
	resolvePorts: (config: Record<string, unknown>) => FlowNodePortDefinition[];
};

const ALL_TYPES = ["text", "json", "artifact"] as const;
const definitions = new Map<FlowNodeTypeId, RegisteredDefinition>();

function input(id: string, label: string, dataTypes: readonly ("text" | "json" | "artifact")[], required: boolean = false, defaultConnect: boolean = false): FlowNodePortDefinition {
	return { id, label, direction: "input", dataTypes: [...dataTypes], required, multiple: false, defaultConnect };
}

function output(id: string, label: string, dataTypes: readonly ("text" | "json" | "artifact")[], defaultConnect: boolean = false): FlowNodePortDefinition {
	return { id, label, direction: "output", dataTypes: [...dataTypes], required: false, multiple: true, defaultConnect };
}

function clonePorts(ports: readonly FlowNodePortDefinition[]): FlowNodePortDefinition[] {
	return ports.map((port): FlowNodePortDefinition => ({ ...port, dataTypes: [...port.dataTypes] }));
}

function resolveDeclaredPorts(definition: FlowNodeTypeDefinition, config: Record<string, unknown>): FlowNodePortDefinition[] {
	const ports = clonePorts(definition.ports);
	for (const dynamic of definition.dynamicPorts ?? []) {
		const values = config[dynamic.configField];
		if (!Array.isArray(values)) continue;
		for (const value of values.slice(0, 64 - ports.length)) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
			const record = value as Record<string, unknown>;
			const id = record[dynamic.idField];
			const label = record[dynamic.labelField];
			if (typeof id !== "string" || id.length === 0 || id.length > 240 || ports.some((port): boolean => port.id === id && port.direction === dynamic.direction)) continue;
			const configuredType = dynamic.dataTypeField === undefined ? undefined : record[dynamic.dataTypeField];
			const dataTypes = typeof configuredType === "string" && ["text", "json", "artifact"].includes(configuredType) ? [configuredType as "text" | "json" | "artifact"] : [...dynamic.dataTypes];
			ports.push({ id, label: typeof label === "string" && label.length > 0 ? label.slice(0, 200) : id, direction: dynamic.direction, dataTypes, required: dynamic.required, multiple: dynamic.multiple, defaultConnect: dynamic.defaultConnect });
		}
	}
	return ports;
}

function publicDefinition(definition: RegisteredDefinition): FlowNodeTypeDefinition {
	const { parseConfig: _parseConfig, resolvePorts: _resolvePorts, ...value } = definition;
	return { ...structuredClone(value), ports: clonePorts(value.ports) };
}

export function registerFlowNodeDefinition(registration: FlowNodeDefinitionRegistration): void {
	if (definitions.has(registration.typeId)) throw Object.assign(new Error(`Flow node type is already registered: ${registration.typeId}`), { code: "flow_node_type_conflict" });
	if (!registration.typeId.startsWith(`${registration.pluginId}/`)) throw Object.assign(new Error("Flow node type ID must use the declaring plugin namespace."), { code: "flow_node_type_invalid" });
	const { parseConfig: registeredParser, resolvePorts: registeredResolver, ...serializable } = registration;
	const parseConfig = registeredParser ?? ((value: Record<string, unknown>): Record<string, unknown> => structuredClone(value));
	const resolvePorts = registeredResolver ?? ((config: Record<string, unknown>): FlowNodePortDefinition[] => resolveDeclaredPorts(serializable, config));
	definitions.set(registration.typeId, { ...structuredClone(serializable), parseConfig, resolvePorts });
}

export function unregisterPluginFlowNodeDefinitions(pluginId: string): void {
	for (const [typeId, definition] of definitions) if (definition.pluginId === pluginId) definitions.delete(typeId);
}

export function unregisterFlowNodeDefinition(typeId: FlowNodeTypeId): void {
	definitions.delete(typeId);
}

function schemaRecord(schema: ZodType): Record<string, unknown> {
	return z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<string, unknown>;
}

function registerBuiltin(
	name: string,
	category: string,
	defaultTitle: string,
	defaultConfig: Record<string, unknown>,
	ports: FlowNodePortDefinition[],
	configSchema: ZodType,
	options: {
		workspaceRequired?: boolean;
		sideEffecting?: boolean;
		executable?: boolean;
		cachePolicy?: "always" | "read-only" | "never";
		summaryFields?: string[];
		dynamicPorts?: FlowNodeTypeDefinition["dynamicPorts"];
		resolvePorts?: (config: Record<string, unknown>) => FlowNodePortDefinition[];
		fieldControls?: Record<string, "provider" | "model" | "reasoning-effort">;
	} = {},
): void {
	const typeId = `builtin/${name}`;
	const configSchemaDefinition = schemaRecord(configSchema);
	if (options.fieldControls !== undefined) {
		const properties = configSchemaDefinition.properties;
		if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
			for (const [field, control] of Object.entries(options.fieldControls)) {
				const property = (properties as Record<string, unknown>)[field];
				if (property !== null && typeof property === "object" && !Array.isArray(property)) {
					(properties as Record<string, unknown>)[field] = {
						...(property as Record<string, unknown>),
						"x-daedalus-control": control,
					};
				}
			}
		}
	}
	registerFlowNodeDefinition({
		typeId,
		pluginId: "builtin",
		pluginVersion: "1.0.0",
		pluginFingerprint: "builtin@1.0.0",
		configVersion: 1,
		category,
		workspaceRequired: options.workspaceRequired === true,
		sideEffecting: options.sideEffecting === true,
		executable: options.executable !== false,
		cachePolicy: options.cachePolicy ?? "always",
		defaultTitle,
		defaultConfig,
		configSchema: configSchemaDefinition,
		summaryFields: options.summaryFields ?? [],
		ui: { kind: "schema" },
		ports,
		...(options.dynamicPorts === undefined ? {} : { dynamicPorts: options.dynamicPorts }),
		parseConfig(value): Record<string, unknown> {
			return configSchema.parse({ ...structuredClone(defaultConfig), ...value }) as Record<string, unknown>;
		},
		...(options.resolvePorts === undefined ? {} : { resolvePorts: options.resolvePorts }),
	});
}

function dynamicInputs(config: Record<string, unknown>, outputs: FlowNodePortDefinition[], minimum: number): FlowNodePortDefinition[] {
	const configured = Array.isArray(config.inputs) ? config.inputs : [];
	const inputs = configured.flatMap((candidate, index): FlowNodePortDefinition[] => {
		if (candidate === null || typeof candidate !== "object") return [];
		const record = candidate as Record<string, unknown>;
		if (typeof record.id !== "string" || typeof record.label !== "string") return [];
		const dataType = record.dataType === "json" || record.dataType === "artifact" ? record.dataType : "text";
		return [input(record.id, record.label, [dataType], true, index === 0)];
	});
	return inputs.length >= minimum ? [...inputs, ...clonePorts(outputs)] : clonePorts(outputs);
}

registerBuiltin("prompt", "basic", "Prompt", { text: "" }, [output("output", "Prompt", ["text"], true)], flowDocumentNodeConfigSchemas["builtin/prompt"], { summaryFields: ["text"] });
registerBuiltin("text", "basic", "Text", { text: "" }, [output("output", "Text", ["text"], true)], flowDocumentNodeConfigSchemas["builtin/text"], { summaryFields: ["text"] });
registerBuiltin("template", "basic", "Template", { template: "{{input}}", inputs: [{ id: "input", label: "Input", dataType: "text" }] }, [output("output", "Text", ["text"], true)], flowDocumentNodeConfigSchemas["builtin/template"], {
	summaryFields: ["template"],
	dynamicPorts: [{ configField: "inputs", direction: "input", idField: "id", labelField: "label", dataTypes: ["text"], dataTypeField: "dataType", required: true, multiple: false, defaultConnect: true }],
	resolvePorts: (config): FlowNodePortDefinition[] => dynamicInputs(config, [output("output", "Text", ["text"], true)], 1),
});
registerBuiltin("merge", "basic", "Merge", { mode: "concat", separator: "\n", inputs: [{ id: "input-1", label: "Input 1", dataType: "text" }, { id: "input-2", label: "Input 2", dataType: "text" }] }, [output("output", "Merged", ALL_TYPES, true)], flowDocumentNodeConfigSchemas["builtin/merge"], {
	summaryFields: ["mode"],
	dynamicPorts: [{ configField: "inputs", direction: "input", idField: "id", labelField: "label", dataTypes: ["text"], dataTypeField: "dataType", required: true, multiple: false, defaultConnect: true }],
	resolvePorts: (config): FlowNodePortDefinition[] => dynamicInputs(config, [output("output", "Merged", ALL_TYPES, true)], 2),
});
registerBuiltin("json-extract", "basic", "JSON Extract", { pointer: "/" }, [input("input", "JSON", ["text", "json"], true, true), output("output", "Value", ["json"], true)], flowDocumentNodeConfigSchemas["builtin/json-extract"], { summaryFields: ["pointer"] });
registerBuiltin("condition", "basic", "Condition", { pointer: "/", operator: "equals" }, [input("input", "Value", ["text", "json"], true, true), output("true", "True", ["text", "json"], true), output("false", "False", ["text", "json"])], flowDocumentNodeConfigSchemas["builtin/condition"], { summaryFields: ["operator", "pointer"] });
registerBuiltin("file-input", "workspace", "File Input", { path: "", mode: "text" }, [output("output", "File", ALL_TYPES, true)], flowDocumentNodeConfigSchemas["builtin/file-input"], {
	workspaceRequired: true,
	summaryFields: ["path"],
	resolvePorts: (config): FlowNodePortDefinition[] => [output("output", "File", [config.mode === "json" || config.mode === "artifact" ? config.mode : "text"], true)],
});
registerBuiltin("llm", "ai", "LLM", { provider: "", model: "", reasoningEffort: "", systemPrompt: "" }, [input("input", "Prompt", ["text", "json"], false, true), output("output", "Response", ["text"], true)], flowDocumentNodeConfigSchemas["builtin/llm"], {
	summaryFields: ["provider", "model"],
	fieldControls: {
		provider: "provider",
		model: "model",
		reasoningEffort: "reasoning-effort",
	},
});
registerBuiltin("tool", "workspace", "Tool", { toolName: "", args: {}, bindings: [] }, [input("input", "Arguments", ["text", "json"], false, true), output("result", "Result", ["json"], true), output("text", "Text", ["text"]), output("artifact", "Artifact", ["artifact"])], flowDocumentNodeConfigSchemas["builtin/tool"], { sideEffecting: true, cachePolicy: "read-only", summaryFields: ["toolName"] });
registerBuiltin("command", "workspace", "Command", { commandLine: "", cwd: "", env: {}, timeoutMs: 30_000 }, [input("stdin", "stdin", ["text"], false, true), output("result", "Result", ["json"], true), output("stdout", "stdout", ["text"]), output("stderr", "stderr", ["text"])], flowDocumentNodeConfigSchemas["builtin/command"], { workspaceRequired: true, sideEffecting: true, cachePolicy: "never", summaryFields: ["commandLine"] });
registerBuiltin("output", "basic", "Output", { format: "text" }, [input("input", "Value", ALL_TYPES, true, true)], flowDocumentNodeConfigSchemas["builtin/output"], { summaryFields: ["format"] });
registerBuiltin("note", "basic", "Note", { text: "" }, [], flowDocumentNodeConfigSchemas["builtin/note"], { executable: false, cachePolicy: "never", summaryFields: ["text"] });

export function listFlowNodeTypeDefinitions(_workspaceAvailable: boolean): FlowNodeTypeDefinition[] {
	return [...definitions.values()].map(publicDefinition).sort((left, right): number => left.typeId.localeCompare(right.typeId));
}

export function findFlowNodeTypeDefinition(typeId: FlowNodeTypeId): FlowNodeTypeDefinition | undefined {
	const definition = definitions.get(typeId);
	return definition === undefined ? undefined : publicDefinition(definition);
}

export function getFlowNodeTypeDefinition(typeId: FlowNodeTypeId): FlowNodeTypeDefinition {
	const definition = findFlowNodeTypeDefinition(typeId);
	if (definition === undefined) throw Object.assign(new Error(`Flow node type is unavailable: ${typeId}`), { code: "flow_node_type_unavailable" });
	return definition;
}

export function normalizeFlowNodeConfig(typeId: FlowNodeTypeId, value: Record<string, unknown> | undefined): Record<string, unknown> {
	const definition = definitions.get(typeId);
	if (definition === undefined) throw Object.assign(new Error(`Flow node type is unavailable: ${typeId}`), { code: "flow_node_type_unavailable" });
	return definition.parseConfig({ ...structuredClone(definition.defaultConfig), ...(value ?? {}) });
}

export function resolveFlowNodePorts(node: Pick<FlowDocumentNode, "typeId" | "config" | "ports">): FlowNodePortDefinition[] {
	const definition = definitions.get(node.typeId);
	if (definition === undefined) return clonePorts(node.ports);
	return clonePorts(definition.resolvePorts(node.config));
}

export function getFlowNodePort(node: Pick<FlowDocumentNode, "typeId" | "config" | "ports">, portId: string, direction: "input" | "output"): FlowNodePortDefinition | undefined {
	return resolveFlowNodePorts(node).find((port): boolean => port.id === portId && port.direction === direction);
}

export function areFlowPortsCompatible(source: FlowNodePortDefinition, target: FlowNodePortDefinition, dataType: "text" | "json" | "artifact"): boolean {
	return source.direction === "output" && target.direction === "input" && source.dataTypes.includes(dataType) && target.dataTypes.includes(dataType);
}
