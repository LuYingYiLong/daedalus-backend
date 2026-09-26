import { IMAGE_ENGINE_FINGERPRINT } from "../media/image-processing.js";
import { registerComposableDefinitions } from "./flow-composable-definitions.js";
import { FLOW_VALUE_TYPES, acceptsFlowCardinality, type FlowValueType } from "../protocol/flow-value-types.js";
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

const ALL_TYPES = FLOW_VALUE_TYPES;
const definitions = new Map<FlowNodeTypeId, RegisteredDefinition>();

function fixed(id: string, label: string, configField: string = id): FlowNodeParameterDefinition {
	return { id, label, mode: "fixed", configField };
}

function connection(
	id: string,
	label: string,
	dataTypes: readonly (FlowValueType)[],
	required: boolean = false,
	defaultConnect: boolean = false,
): Extract<FlowNodeParameterDefinition, { mode: "connection" }> {
	return { id, label, mode: "connection", dataTypes: [...dataTypes], required, multiple: false, defaultConnect };
}

function hybrid(
	id: string,
	label: string,
	configField: string,
	dataTypes: readonly (FlowValueType)[],
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
	dataTypes: readonly (FlowValueType)[],
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
				typeof configuredType === "string" && (FLOW_VALUE_TYPES as readonly string[]).includes(configuredType)
					? [configuredType as FlowValueType]
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
					...(parameter.cardinality === undefined ? {} : { cardinality: parameter.cardinality }),
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
		...(definition.cardinality === undefined ? {} : { cardinality: definition.cardinality }),
	}));
	const ports = [...inputs, ...outputs];
	if (definition.typeId === "builtin/flow-input") for (const port of ports) if (port.direction === "output") {
		port.dataTypes = [FLOW_VALUE_TYPES.includes(config.dataType as FlowValueType) ? config.dataType as FlowValueType : "text"];
		port.cardinality = config.cardinality === "many" ? "many" : "one";
	}
	if (typeof config.elementType === "string" && FLOW_VALUE_TYPES.includes(config.elementType as FlowValueType))
		for (const port of ports) if (port.id !== "index") port.dataTypes = [config.elementType as FlowValueType];
	return ports;
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

function connectableType(field: string, schema: Record<string, unknown>, control: string | undefined): FlowValueType | null {
	if (["flow-input-value", "parameter-sets", "typed-list"].includes(control ?? "")) return null;
	if (control === "provider" || control === "model") return "text";
	if (control === "color" || control === "size") return control;
	if (schema.type === "number" || schema.type === "integer") return "number";
	if (schema.type === "boolean") return "boolean";
	if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((value) => typeof value === "number")) return "number";
	if (schema.type === "string" || Array.isArray(schema.enum)) return "text";
	if (field === "value" && schema.type === undefined) return "json";
	return null;
}

export function registerBuiltin(
	name: string,
	category: string,
	defaultTitle: string,
	defaultConfig: Record<string, unknown>,
	parameters: FlowNodeParameterDefinition[],
	outputs: FlowNodeOutputDefinition[],
	configSchema: ZodType,
	options: {
		terminal?: boolean;
		batch?: boolean;
		modelCapability?: FlowNodeTypeDefinition["modelCapability"];
		workspaceRequired?: boolean;
		sideEffecting?: boolean;
		executable?: boolean;
		cachePolicy?: "always" | "read-only" | "never";
		summaryFields?: string[];
		configVersion?: number;
		dynamicParameters?: FlowNodeTypeDefinition["dynamicParameters"];
		fieldControls?: Record<string, string>;
		fieldUnits?: Record<string, string>;
		fieldFileKinds?: Record<string, "image" | "video" | "audio">;
		fieldPreviews?: Record<string, "image" | "video" | "audio">;
	} = {},
): void {
	const typeId = `builtin/${name}`;
	const configSchemaDefinition = schemaRecord(configSchema);
	const schemaProperties = configSchemaDefinition.properties;
	const properties = schemaProperties !== null && typeof schemaProperties === "object" && !Array.isArray(schemaProperties)
		? schemaProperties as Record<string, unknown>
		: {};
	const connectableParameters = parameters.map((parameter): FlowNodeParameterDefinition => {
		if (parameter.mode !== "fixed" || category === "parameters" || name === "flow-input" || name === "note" || name === "command" || name === "tool") return parameter;
		if (["inputs", "rows", "values", "elementType", "bindings", "args", "env"].includes(parameter.configField)) return parameter;
		const schema = properties[parameter.configField];
		if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return parameter;
		const dataType = connectableType(parameter.configField, schema as Record<string, unknown>, options.fieldControls?.[parameter.configField]);
		return dataType === null ? parameter : hybrid(parameter.id, parameter.label, parameter.configField, [dataType]);
	});
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
	if (options.fieldUnits !== undefined) {
		const properties = configSchemaDefinition.properties;
		if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
			for (const [field, unit] of Object.entries(options.fieldUnits)) {
				const property = (properties as Record<string, unknown>)[field];
				if (property !== null && typeof property === "object" && !Array.isArray(property))
					(properties as Record<string, unknown>)[field] = {
						...(property as Record<string, unknown>),
						"x-daedalus-unit": unit,
					};
			}
		}
	}
	for (const [fields, annotation] of [
		[options.fieldFileKinds, "x-daedalus-file-kind"],
		[options.fieldPreviews, "x-daedalus-preview"],
	] as const) {
		if (fields === undefined) continue;
		const properties = configSchemaDefinition.properties;
		if (properties === null || typeof properties !== "object" || Array.isArray(properties)) continue;
		for (const [field, value] of Object.entries(fields)) {
			const property = (properties as Record<string, unknown>)[field];
			if (property !== null && typeof property === "object" && !Array.isArray(property))
				(properties as Record<string, unknown>)[field] = {
					...(property as Record<string, unknown>),
					[annotation]: value,
				};
		}
	}
	registerFlowNodeDefinition({
		typeId,
		pluginId: "builtin",
		pluginVersion: "4.0.0",
		pluginFingerprint: `builtin@4.0.0/${IMAGE_ENGINE_FINGERPRINT}`,
		configVersion: options.configVersion ?? 4,
		category,
		...(options.modelCapability ? { modelCapability: options.modelCapability } : {}),
		...(options.batch ? { batch: true } : {}),
		terminal: options.terminal ?? (name === "output" || name === "media-output"),
		workspaceRequired: options.workspaceRequired === true,
		sideEffecting: options.sideEffecting === true,
		executable: options.executable !== false,
		cachePolicy: options.cachePolicy ?? "always",
		defaultTitle,
		defaultConfig,
		configSchema: configSchemaDefinition,
		summaryFields: options.summaryFields ?? [],
		ui: { kind: "schema" },
		parameters: connectableParameters,
		outputs,
		...(options.dynamicParameters === undefined ? {} : { dynamicParameters: options.dynamicParameters }),
		parseConfig(value): Record<string, unknown> {
			const { hiddenInputPorts, ...fields } = value;
			const normalized = configSchema.parse({ ...structuredClone(defaultConfig), ...fields }) as Record<string, unknown>;
			if (Array.isArray(hiddenInputPorts)) {
				const allowed = new Set(connectableParameters.filter((parameter) => parameter.mode === "hybrid").map((parameter) => parameter.id));
				const hidden = [...new Set(hiddenInputPorts.filter((id): id is string => typeof id === "string" && allowed.has(id)))];
				if (hidden.length > 0) normalized.hiddenInputPorts = hidden;
			}
			return normalized;
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

registerBuiltin("user-prompt", "basic", "User Prompt", { text: "" }, [hybrid("input", "User prompt", "text", ["text"], false, true)], [output("output", "User prompt", ["text"], true)], flowDocumentNodeConfigSchemas["builtin/user-prompt"], { summaryFields: ["text"] });
registerBuiltin("system-prompt", "basic", "System Prompt", { text: "" }, [fixed("text", "System prompt")], [output("output", "System prompt", ["text"], true)], flowDocumentNodeConfigSchemas["builtin/system-prompt"], { summaryFields: ["text"] });
registerBuiltin("text", "parameters", "Text", { text: "" }, [fixed("text", "Text")], [output("output", "Text", ["text"], true)], flowDocumentNodeConfigSchemas["builtin/text"], { summaryFields: ["text"] });
registerBuiltin("template", "basic", "Template", { template: "{{input}}", inputs: [{ id: "input", label: "Input", dataType: "text" }] }, [fixed("template", "Template"), fixed("inputs", "Inputs")], [output("output", "Text", ["text"], true)], flowDocumentNodeConfigSchemas["builtin/template"], { summaryFields: ["template"], dynamicParameters: dynamicInputs });
registerBuiltin("merge", "basic", "Merge", { mode: "concat", separator: "\n", inputs: [{ id: "input-1", label: "Input 1", dataType: "text" }, { id: "input-2", label: "Input 2", dataType: "text" }] }, [fixed("mode", "Mode"), fixed("separator", "Separator"), fixed("inputs", "Inputs")], [output("output", "Merged", ALL_TYPES, true)], flowDocumentNodeConfigSchemas["builtin/merge"], { summaryFields: ["mode"], dynamicParameters: dynamicInputs });
registerBuiltin("json-extract", "basic", "JSON Extract", { pointer: "/" }, [connection("input", "JSON", ["text", "json"], true, true), fixed("pointer", "Pointer")], [output("output", "Value", ["json"], true)], flowDocumentNodeConfigSchemas["builtin/json-extract"], { summaryFields: ["pointer"] });
registerBuiltin("condition", "basic", "Condition", { pointer: "/", operator: "equals" }, [connection("input", "Value", ["text", "json"], true, true), fixed("pointer", "Pointer"), fixed("operator", "Operator"), fixed("value", "Expected value")], [{ ...output("true", "True", ["text", "json"], true), optional: true }, { ...output("false", "False", ["text", "json"]), optional: true }], flowDocumentNodeConfigSchemas["builtin/condition"], { summaryFields: ["operator", "pointer"] });
registerBuiltin("file-input", "workspace", "File Input", { path: "", mode: "text" }, [fixed("path", "Path"), fixed("mode", "Mode")], [output("output", "File", ALL_TYPES, true)], flowDocumentNodeConfigSchemas["builtin/file-input"], { workspaceRequired: true, summaryFields: ["path"], fieldControls: { path: "workspace-file" } });
registerBuiltin("flow-input", "basic", "Flow Input", { label: "Input", dataType: "text", cardinality: "one", defaultValue: "" }, [fixed("label", "Name"), fixed("dataType", "Type"), fixed("cardinality", "Cardinality"), fixed("defaultValue", "Default value")], [output("output", "Value", [...FLOW_VALUE_TYPES], true)], flowDocumentNodeConfigSchemas["builtin/flow-input"], { cachePolicy: "never", summaryFields: ["label", "dataType"], fieldControls: { defaultValue: "flow-input-value" } });
registerBuiltin("llm", "ai", "LLM", { provider: "", model: "", reasoningEffort: "", userPrompt: "", systemPrompt: "" }, [hybrid("user-prompt", "User prompt", "userPrompt", ["text"], false, true), hybrid("system-prompt", "System prompt", "systemPrompt", ["text"], false), fixed("provider", "Provider"), fixed("model", "Model"), fixed("reasoningEffort", "Reasoning effort")], [output("output", "Response", ["text"], true)], flowDocumentNodeConfigSchemas["builtin/llm"], { summaryFields: ["provider", "model"], fieldControls: { provider: "provider", model: "model", reasoningEffort: "reasoning-effort" } });
registerBuiltin("tool", "workspace", "Tool", { toolName: "", args: {}, bindings: [] }, [connection("input", "Arguments", ["text"], false, true), fixed("toolName", "Tool"), fixed("args", "Arguments"), fixed("bindings", "Bindings")], [output("result", "Result", ["json"], true), output("text", "Text", ["text"]), output("artifact", "Artifact", ["artifact"])], flowDocumentNodeConfigSchemas["builtin/tool"], { sideEffecting: true, cachePolicy: "read-only", summaryFields: ["toolName"] });
registerBuiltin("command", "workspace", "Command", { commandLine: "", cwd: "", env: {}, timeoutMs: 30_000, stdin: "" }, [hybrid("stdin", "stdin", "stdin", ["text"], false, true), fixed("commandLine", "Command"), fixed("cwd", "Working directory"), fixed("env", "Environment"), fixed("timeoutMs", "Timeout")], [output("result", "Result", ["json"], true), output("stdout", "stdout", ["text"]), output("stderr", "stderr", ["text"])], flowDocumentNodeConfigSchemas["builtin/command"], { workspaceRequired: true, sideEffecting: true, cachePolicy: "never", summaryFields: ["commandLine"] });
registerBuiltin("text-to-image", "media-generation", "Text to Image", { provider: "", model: "", prompt: "", negativePrompt: "", aspectRatio: "1:1", style: "", count: 1, outputFormat: "png" }, [fixed("provider", "Provider"), fixed("model", "Model"), hybrid("prompt", "Prompt", "prompt", ["text"], true, true), hybrid("negativePrompt", "Negative prompt", "negativePrompt", ["text"]), fixed("aspectRatio", "Aspect ratio"), fixed("style", "Style"), hybrid("seed", "Seed", "seed", ["number"], false), hybrid("count", "Count", "count", ["number"]), fixed("outputFormat", "Output format")], [output("image", "First image", ["image"], true), { ...output("images", "All images", ["image"]), cardinality: "many" }], flowDocumentNodeConfigSchemas["builtin/text-to-image"], { modelCapability: "imageGeneration", summaryFields: ["provider", "model"], fieldControls: { provider: "provider", model: "model" } });
registerBuiltin("image-to-image", "media-generation", "Image to Image", { provider: "", model: "", prompt: "", negativePrompt: "", aspectRatio: "1:1", style: "", count: 1, outputFormat: "png" }, [connection("image", "Image", ["image"], true, true), fixed("provider", "Provider"), fixed("model", "Model"), hybrid("prompt", "Prompt", "prompt", ["text"], false, true), hybrid("negativePrompt", "Negative prompt", "negativePrompt", ["text"]), fixed("aspectRatio", "Aspect ratio"), fixed("style", "Style"), hybrid("seed", "Seed", "seed", ["number"], false), hybrid("count", "Count", "count", ["number"]), fixed("outputFormat", "Output format")], [output("image", "First image", ["image"], true), { ...output("images", "All images", ["image"]), cardinality: "many" }], flowDocumentNodeConfigSchemas["builtin/image-to-image"], { modelCapability: "imageEdit", summaryFields: ["provider", "model"], fieldControls: { provider: "provider", model: "model" } });
registerBuiltin("text-to-video", "media-generation", "Text to Video", { provider: "", model: "", prompt: "", negativePrompt: "", size: { width: 1280, height: 720 }, durationMs: 5_000, fps: 24, count: 1, outputFormat: "mp4" }, [fixed("provider", "Provider"), fixed("model", "Model"), hybrid("prompt", "Prompt", "prompt", ["text"], true, true), hybrid("negativePrompt", "Negative prompt", "negativePrompt", ["text"]), hybrid("size", "Size", "size", ["size"]), hybrid("durationMs", "Duration", "durationMs", ["number"]), hybrid("fps", "Frame rate", "fps", ["number"]), hybrid("seed", "Seed", "seed", ["number"], false), hybrid("count", "Count", "count", ["number"]), fixed("outputFormat", "Output format")], [output("video", "Video", ["video"], true)], flowDocumentNodeConfigSchemas["builtin/text-to-video"], { configVersion: 5, modelCapability: "textToVideo", summaryFields: ["provider", "model"], fieldControls: { provider: "provider", model: "model", size: "size" }, fieldUnits: { durationMs: "ms", fps: "fps" } });
registerBuiltin("image-to-video", "media-generation", "Image to Video", { provider: "", model: "", prompt: "", negativePrompt: "", size: { width: 1280, height: 720 }, durationMs: 5_000, fps: 24, count: 1, outputFormat: "mp4" }, [connection("image", "Image", ["image"], true, true), fixed("provider", "Provider"), fixed("model", "Model"), hybrid("prompt", "Prompt", "prompt", ["text"], false, true), hybrid("negativePrompt", "Negative prompt", "negativePrompt", ["text"]), hybrid("size", "Size", "size", ["size"]), hybrid("durationMs", "Duration", "durationMs", ["number"]), hybrid("fps", "Frame rate", "fps", ["number"]), hybrid("seed", "Seed", "seed", ["number"], false), hybrid("count", "Count", "count", ["number"]), fixed("outputFormat", "Output format")], [output("video", "Video", ["video"], true)], flowDocumentNodeConfigSchemas["builtin/image-to-video"], { configVersion: 5, modelCapability: "imageToVideo", summaryFields: ["provider", "model"], fieldControls: { provider: "provider", model: "model", size: "size" }, fieldUnits: { durationMs: "ms", fps: "fps" } });
registerBuiltin("output", "basic", "Output", { format: "text" }, [connection("input", "Value", ALL_TYPES, true, true), fixed("format", "Format")], [], flowDocumentNodeConfigSchemas["builtin/output"], { summaryFields: ["format"] });
registerBuiltin("media-output", "media-output", "Media Output", { format: "preview" }, [{ ...connection("input", "Media", ["image", "video", "audio", "frames", "artifact"], true, true), cardinality: "one-or-many" }, fixed("format", "Display mode")], [], flowDocumentNodeConfigSchemas["builtin/media-output"], { summaryFields: ["format"] });
registerBuiltin("note", "basic", "Note", { text: "" }, [fixed("text", "Note")], [], flowDocumentNodeConfigSchemas["builtin/note"], { executable: false, cachePolicy: "never", summaryFields: ["text"] });

registerComposableDefinitions(registerBuiltin);

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
	const config = { ...structuredClone(definition.defaultConfig), ...(value ?? {}) };
	if (typeId === "builtin/flow-input") delete config.required;
	return definition.parseConfig(config);
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

export function areFlowPortsCompatible(source: FlowNodePortDefinition, target: FlowNodePortDefinition, dataType: FlowValueType): boolean {
	return acceptsFlowCardinality(source.cardinality, target.cardinality) && source.direction === "output" && target.direction === "input" && source.dataTypes.includes(dataType) && target.dataTypes.includes(dataType);
}
