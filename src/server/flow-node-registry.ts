import { z, type ZodType } from "zod";
import { flowDocumentNodeConfigSchemas } from "../protocol/schema.js";
import type {
	FlowDocumentNode,
	FlowNodeOutputDefinition,
	FlowNodeParameterDefinition,
	FlowNodePortDefinition,
	FlowNodeTypeDefinition,
	FlowNodeTypeId,
} from "../protocol/types.js";

export type FlowNodeDefinitionRegistration = FlowNodeTypeDefinition & {
	parseConfig?: ((value: Record<string, unknown>) => Record<string, unknown>) | undefined;
};

type RegisteredDefinition = FlowNodeTypeDefinition & {
	parseConfig: (value: Record<string, unknown>) => Record<string, unknown>;
};

const ALL_TYPES = ["text", "json", "artifact"] as const;
const definitions = new Map<FlowNodeTypeId, RegisteredDefinition>();

function fixed(id: string, label: string, configField: string = id): FlowNodeParameterDefinition {
	return { id, label, mode: "fixed", configField };
}

function connection(
	id: string,
	label: string,
	dataTypes: readonly ("text" | "json" | "artifact")[],
	required: boolean = false,
	defaultConnect: boolean = false,
): FlowNodeParameterDefinition {
	return { id, label, mode: "connection", dataTypes: [...dataTypes], required, multiple: false, defaultConnect };
}

function hybrid(
	id: string,
	label: string,
	configField: string,
	dataTypes: readonly ("text" | "json" | "artifact")[],
	required: boolean = false,
	defaultConnect: boolean = false,
): FlowNodeParameterDefinition {
	return {
		id,
		label,
		mode: "hybrid",
		configField,
		dataTypes: [...dataTypes],
		required,
		multiple: false,
		defaultConnect,
		hideControlWhenConnected: true,
	};
}

function output(
	id: string,
	label: string,
	dataTypes: readonly ("text" | "json" | "artifact")[],
	defaultConnect: boolean = false,
): FlowNodeOutputDefinition {
	return { id, label, dataTypes: [...dataTypes], defaultConnect };
}

function cloneParameters(parameters: readonly FlowNodeParameterDefinition[]): FlowNodeParameterDefinition[] {
	return parameters.map((parameter): FlowNodeParameterDefinition => structuredClone(parameter));
}

function clonePorts(ports: readonly FlowNodePortDefinition[]): FlowNodePortDefinition[] {
	return ports.map((port): FlowNodePortDefinition => ({ ...port, dataTypes: [...port.dataTypes] }));
}

function resolveDeclaredParameters(
	definition: Pick<FlowNodeTypeDefinition, "parameters" | "dynamicParameters">,
	config: Record<string, unknown>,
): FlowNodeParameterDefinition[] {
	const parameters = cloneParameters(definition.parameters);
	for (const dynamic of definition.dynamicParameters ?? []) {
		const values = config[dynamic.configField];
		if (!Array.isArray(values)) continue;
		for (const value of values.slice(0, 64 - parameters.length)) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
			const record = value as Record<string, unknown>;
			const id = record[dynamic.idField];
			const label = record[dynamic.labelField];
			if (
				typeof id !== "string" ||
				id.length === 0 ||
				id.length > 240 ||
				parameters.some((parameter): boolean => parameter.id === id)
			)
				continue;
			const configuredType = dynamic.dataTypeField === undefined ? undefined : record[dynamic.dataTypeField];
			const dataTypes =
				typeof configuredType === "string" && ["text", "json", "artifact"].includes(configuredType)
					? [configuredType as "text" | "json" | "artifact"]
					: [...dynamic.dataTypes];
			parameters.push({
				id,
				label: typeof label === "string" && label.length > 0 ? label.slice(0, 200) : id,
				mode: "connection",
				dataTypes,
				required: dynamic.required,
				multiple: dynamic.multiple,
				defaultConnect: dynamic.defaultConnect,
			});
		}
	}
	return parameters;
}

function resolveDeclaredPorts(definition: FlowNodeTypeDefinition, config: Record<string, unknown>): FlowNodePortDefinition[] {
	const inputs = resolveDeclaredParameters(definition, config).flatMap((parameter): FlowNodePortDefinition[] =>
		parameter.mode === "fixed"
			? []
			: [{
					id: parameter.id,
					label: parameter.label,
					direction: "input",
					dataTypes: [...parameter.dataTypes],
					required: parameter.required,
					multiple: parameter.multiple,
					defaultConnect: parameter.defaultConnect,
				}],
	);
	const outputs = definition.outputs.map((definition): FlowNodePortDefinition => ({
		id: definition.id,
		label: definition.label,
		direction: "output",
		dataTypes: [...definition.dataTypes],
		required: false,
		multiple: true,
		defaultConnect: definition.defaultConnect,
	}));
	return [...inputs, ...outputs];
}

function publicDefinition(definition: RegisteredDefinition): FlowNodeTypeDefinition {
	const { parseConfig: _parseConfig, ...value } = definition;
	return structuredClone(value);
}

export function registerFlowNodeDefinition(registration: FlowNodeDefinitionRegistration): void {
	if (definitions.has(registration.typeId))
		throw Object.assign(new Error(`Flow node type is already registered: ${registration.typeId}`), { code: "flow_node_type_conflict" });
	if (!registration.typeId.startsWith(`${registration.pluginId}/`))
		throw Object.assign(new Error("Flow node type ID must use the declaring plugin namespace."), { code: "flow_node_type_invalid" });
	const { parseConfig: registeredParser, ...serializable } = registration;
	const parseConfig = registeredParser ?? ((value: Record<string, unknown>): Record<string, unknown> => structuredClone(value));
	definitions.set(registration.typeId, { ...structuredClone(serializable), parseConfig });
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
	parameters: FlowNodeParameterDefinition[],
	outputs: FlowNodeOutputDefinition[],
	configSchema: ZodType,
	options: {
		workspaceRequired?: boolean;
		sideEffecting?: boolean;
		executable?: boolean;
		cachePolicy?: "always" | "read-only" | "never";
		summaryFields?: string[];
		dynamicParameters?: FlowNodeTypeDefinition["dynamicParameters"];
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
				if (property !== null && typeof property === "object" && !Array.isArray(property))
					(properties as Record<string, unknown>)[field] = {
						...(property as Record<string, unknown>),
						"x-daedalus-control": control,
					};
			}
		}
	}
	registerFlowNodeDefinition({
		typeId,
		pluginId: "builtin",
		pluginVersion: "2.0.0",
		pluginFingerprint: "builtin@2.0.0",
		configVersion: 2,
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
		parameters,
		outputs,
		...(options.dynamicParameters === undefined ? {} : { dynamicParameters: options.dynamicParameters }),
		parseConfig(value): Record<string, unknown> {
			return configSchema.parse({ ...structuredClone(defaultConfig), ...value }) as Record<string, unknown>;
		},
	});
}

const dynamicInputs = [{
	configField: "inputs",
	idField: "id",
	labelField: "label",
	dataTypes: ["text"] as Array<"text">,
	dataTypeField: "dataType",
	required: true,
	multiple: false,
	defaultConnect: true,
}];

registerBuiltin("prompt", "basic", "Prompt", { text: "" }, [fixed("text", "Prompt")], [output("output", "Prompt", ["text"], true)], flowDocumentNodeConfigSchemas["builtin/prompt"], { summaryFields: ["text"] });
registerBuiltin("text", "basic", "Text", { text: "" }, [fixed("text", "Text")], [output("output", "Text", ["text"], true)], flowDocumentNodeConfigSchemas["builtin/text"], { summaryFields: ["text"] });
registerBuiltin("template", "basic", "Template", { template: "{{input}}", inputs: [{ id: "input", label: "Input", dataType: "text" }] }, [fixed("template", "Template"), fixed("inputs", "Inputs")], [output("output", "Text", ["text"], true)], flowDocumentNodeConfigSchemas["builtin/template"], { summaryFields: ["template"], dynamicParameters: dynamicInputs });
registerBuiltin("merge", "basic", "Merge", { mode: "concat", separator: "\n", inputs: [{ id: "input-1", label: "Input 1", dataType: "text" }, { id: "input-2", label: "Input 2", dataType: "text" }] }, [fixed("mode", "Mode"), fixed("separator", "Separator"), fixed("inputs", "Inputs")], [output("output", "Merged", ALL_TYPES, true)], flowDocumentNodeConfigSchemas["builtin/merge"], { summaryFields: ["mode"], dynamicParameters: dynamicInputs });
registerBuiltin("json-extract", "basic", "JSON Extract", { pointer: "/" }, [connection("input", "JSON", ["text", "json"], true, true), fixed("pointer", "Pointer")], [output("output", "Value", ["json"], true)], flowDocumentNodeConfigSchemas["builtin/json-extract"], { summaryFields: ["pointer"] });
registerBuiltin("condition", "basic", "Condition", { pointer: "/", operator: "equals" }, [connection("input", "Value", ["text", "json"], true, true), fixed("pointer", "Pointer"), fixed("operator", "Operator"), fixed("value", "Expected value")], [output("true", "True", ["text", "json"], true), output("false", "False", ["text", "json"])], flowDocumentNodeConfigSchemas["builtin/condition"], { summaryFields: ["operator", "pointer"] });
registerBuiltin("file-input", "workspace", "File Input", { path: "", mode: "text" }, [fixed("path", "Path"), fixed("mode", "Mode")], [output("output", "File", ALL_TYPES, true)], flowDocumentNodeConfigSchemas["builtin/file-input"], { workspaceRequired: true, summaryFields: ["path"] });
registerBuiltin("llm", "ai", "LLM", { provider: "", model: "", reasoningEffort: "", prompt: "", systemPrompt: "" }, [hybrid("input", "Prompt", "prompt", ["text", "json"], false, true), hybrid("system-prompt", "System prompt", "systemPrompt", ["text"], false), fixed("provider", "Provider"), fixed("model", "Model"), fixed("reasoningEffort", "Reasoning effort")], [output("output", "Response", ["text"], true)], flowDocumentNodeConfigSchemas["builtin/llm"], { summaryFields: ["provider", "model"], fieldControls: { provider: "provider", model: "model", reasoningEffort: "reasoning-effort" } });
registerBuiltin("tool", "workspace", "Tool", { toolName: "", args: {}, bindings: [] }, [connection("input", "Arguments", ["text", "json"], false, true), fixed("toolName", "Tool"), fixed("args", "Arguments"), fixed("bindings", "Bindings")], [output("result", "Result", ["json"], true), output("text", "Text", ["text"]), output("artifact", "Artifact", ["artifact"])], flowDocumentNodeConfigSchemas["builtin/tool"], { sideEffecting: true, cachePolicy: "read-only", summaryFields: ["toolName"] });
registerBuiltin("command", "workspace", "Command", { commandLine: "", cwd: "", env: {}, timeoutMs: 30_000, stdin: "" }, [hybrid("stdin", "stdin", "stdin", ["text"], false, true), fixed("commandLine", "Command"), fixed("cwd", "Working directory"), fixed("env", "Environment"), fixed("timeoutMs", "Timeout")], [output("result", "Result", ["json"], true), output("stdout", "stdout", ["text"]), output("stderr", "stderr", ["text"])], flowDocumentNodeConfigSchemas["builtin/command"], { workspaceRequired: true, sideEffecting: true, cachePolicy: "never", summaryFields: ["commandLine"] });
registerBuiltin("output", "basic", "Output", { format: "text" }, [connection("input", "Value", ALL_TYPES, true, true), fixed("format", "Format")], [], flowDocumentNodeConfigSchemas["builtin/output"], { summaryFields: ["format"] });
registerBuiltin("note", "basic", "Note", { text: "" }, [fixed("text", "Note")], [], flowDocumentNodeConfigSchemas["builtin/note"], { executable: false, cachePolicy: "never", summaryFields: ["text"] });

export function listFlowNodeTypeDefinitions(_workspaceAvailable: boolean): FlowNodeTypeDefinition[] {
	return [...definitions.values()].map(publicDefinition).sort((left, right): number => left.typeId.localeCompare(right.typeId));
}

export function findFlowNodeTypeDefinition(typeId: FlowNodeTypeId): FlowNodeTypeDefinition | undefined {
	const definition = definitions.get(typeId);
	return definition === undefined ? undefined : publicDefinition(definition);
}

export function getFlowNodeTypeDefinition(typeId: FlowNodeTypeId): FlowNodeTypeDefinition {
	const definition = findFlowNodeTypeDefinition(typeId);
	if (definition === undefined)
		throw Object.assign(new Error(`Flow node type is unavailable: ${typeId}`), { code: "flow_node_type_unavailable" });
	return definition;
}

export function normalizeFlowNodeConfig(typeId: FlowNodeTypeId, value: Record<string, unknown> | undefined): Record<string, unknown> {
	const definition = definitions.get(typeId);
	if (definition === undefined)
		throw Object.assign(new Error(`Flow node type is unavailable: ${typeId}`), { code: "flow_node_type_unavailable" });
	return definition.parseConfig({ ...structuredClone(definition.defaultConfig), ...(value ?? {}) });
}

export function resolveFlowNodeParameters(node: Pick<FlowDocumentNode, "typeId" | "config">): FlowNodeParameterDefinition[] {
	const definition = definitions.get(node.typeId);
	return definition === undefined ? [] : resolveDeclaredParameters(definition, node.config);
}

export function resolveFlowNodePorts(node: Pick<FlowDocumentNode, "typeId" | "config" | "ports">): FlowNodePortDefinition[] {
	const definition = definitions.get(node.typeId);
	if (definition === undefined) return clonePorts(node.ports);
	return clonePorts(resolveDeclaredPorts(definition, node.config));
}

export function getFlowNodePort(node: Pick<FlowDocumentNode, "typeId" | "config" | "ports">, portId: string, direction: "input" | "output"): FlowNodePortDefinition | undefined {
	return resolveFlowNodePorts(node).find((port): boolean => port.id === portId && port.direction === direction);
}

export function areFlowPortsCompatible(source: FlowNodePortDefinition, target: FlowNodePortDefinition, dataType: "text" | "json" | "artifact"): boolean {
	return source.direction === "output" && target.direction === "input" && source.dataTypes.includes(dataType) && target.dataTypes.includes(dataType);
}
