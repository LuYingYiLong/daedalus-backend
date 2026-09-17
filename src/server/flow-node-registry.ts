import { flowDocumentNodeConfigSchemas } from "../protocol/schema.js";
import type { FlowDocumentNode, FlowDocumentNodeType, FlowNodePortDefinition, FlowNodeTypeDefinition } from "../protocol/types.js";

type NodeDefinitionBase = Omit<FlowNodeTypeDefinition, "defaultConfig" | "ports"> & {
	defaultConfig: Record<string, unknown>;
	ports: FlowNodePortDefinition[];
};

const ALL_TYPES = ["text", "json", "artifact"] as const;

const definitions: Record<FlowDocumentNodeType, NodeDefinitionBase> = {
	prompt: definition("prompt", "basic", "Prompt", { text: "" }, [output("output", "Prompt", ["text"], true)]),
	text: definition("text", "basic", "Text", { text: "" }, [output("output", "Text", ["text"], true)]),
	template: definition("template", "basic", "Template", {
		template: "{{input}}",
		inputs: [{ id: "input", label: "Input", dataType: "text" }],
	}, [input("input", "Input", ALL_TYPES, true, true), output("output", "Text", ["text"], true)]),
	merge: definition("merge", "basic", "Merge", {
		mode: "concat",
		separator: "\n",
		inputs: [
			{ id: "input-1", label: "Input 1", dataType: "text" },
			{ id: "input-2", label: "Input 2", dataType: "text" },
		],
	}, [input("input-1", "Input 1", ALL_TYPES, true, true), input("input-2", "Input 2", ALL_TYPES), output("output", "Merged", ALL_TYPES, true)]),
	json_extract: definition("json_extract", "basic", "JSON Extract", { pointer: "/" }, [input("input", "JSON", ["text", "json"], true, true), output("output", "Value", ["json"], true)]),
	condition: definition("condition", "basic", "Condition", { pointer: "/", operator: "equals" }, [
		input("input", "Value", ["text", "json"], true, true),
		output("true", "True", ["text", "json"], true),
		output("false", "False", ["text", "json"]),
	]),
	file_input: definition("file_input", "workspace", "File Input", { path: "", mode: "text" }, [output("output", "File", ALL_TYPES, true)], true),
	llm: definition("llm", "ai", "LLM", { provider: "", model: "", reasoningEffort: "", systemPrompt: "" }, [input("input", "Prompt", ["text", "json"], false, true), output("output", "Response", ["text"], true)]),
	tool: definition("tool", "workspace", "Tool", { toolName: "", args: {}, bindings: [] }, [input("input", "Arguments", ["text", "json"], false, true), output("result", "Result", ["json"], true), output("text", "Text", ["text"]), output("artifact", "Artifact", ["artifact"])], false, true),
	command: definition("command", "workspace", "Command", { commandLine: "", cwd: "", env: {}, timeoutMs: 30_000 }, [input("stdin", "stdin", ["text"], false, true), output("result", "Result", ["json"], true), output("stdout", "stdout", ["text"]), output("stderr", "stderr", ["text"])], true, true),
	output: definition("output", "basic", "Output", { format: "text" }, [input("input", "Value", ALL_TYPES, true, true)]),
	note: definition("note", "basic", "Note", { text: "" }, []),
};

function definition(
	type: FlowDocumentNodeType,
	category: FlowNodeTypeDefinition["category"],
	defaultTitle: string,
	defaultConfig: Record<string, unknown>,
	ports: FlowNodePortDefinition[],
	workspaceRequired: boolean = false,
	sideEffecting: boolean = false,
): NodeDefinitionBase {
	return { type, category, workspaceRequired, sideEffecting, defaultTitle, defaultConfig, ports };
}

function input(id: string, label: string, dataTypes: readonly ("text" | "json" | "artifact")[], required: boolean = false, defaultConnect: boolean = false): FlowNodePortDefinition {
	return { id, label, direction: "input", dataTypes: [...dataTypes], required, multiple: false, defaultConnect };
}

function output(id: string, label: string, dataTypes: readonly ("text" | "json" | "artifact")[], defaultConnect: boolean = false): FlowNodePortDefinition {
	return { id, label, direction: "output", dataTypes: [...dataTypes], required: false, multiple: true, defaultConnect };
}

export function listFlowNodeTypeDefinitions(_workspaceAvailable: boolean): FlowNodeTypeDefinition[] {
	return Object.values(definitions).map((entry): FlowNodeTypeDefinition => ({
		...entry,
		defaultConfig: structuredClone(entry.defaultConfig),
		ports: entry.ports.map((port): FlowNodePortDefinition => ({ ...port, dataTypes: [...port.dataTypes] })),
		workspaceRequired: entry.workspaceRequired,
	}));
}

export function getFlowNodeTypeDefinition(type: FlowDocumentNodeType): FlowNodeTypeDefinition {
	const entry = definitions[type];
	return {
		...entry,
		defaultConfig: structuredClone(entry.defaultConfig),
		ports: entry.ports.map((port): FlowNodePortDefinition => ({ ...port, dataTypes: [...port.dataTypes] })),
	};
}

export function normalizeFlowNodeConfig(type: FlowDocumentNodeType, value: Record<string, unknown> | undefined): Record<string, unknown> {
	const schema = flowDocumentNodeConfigSchemas[type];
	const merged = { ...structuredClone(definitions[type].defaultConfig), ...(value ?? {}) };
	return schema.parse(merged) as Record<string, unknown>;
}

export function resolveFlowNodePorts(node: Pick<FlowDocumentNode, "type" | "config">): FlowNodePortDefinition[] {
	const base = getFlowNodeTypeDefinition(node.type).ports;
	if (node.type !== "template" && node.type !== "merge") {
		if (node.type === "file_input") {
			const mode = node.config.mode === "json" || node.config.mode === "artifact" ? node.config.mode : "text";
			return base.map((port): FlowNodePortDefinition => port.direction === "output" ? { ...port, dataTypes: [mode] } : port);
		}
		return base;
	}
	const configured = Array.isArray(node.config.inputs) ? node.config.inputs : [];
	const inputs: FlowNodePortDefinition[] = configured.flatMap((candidate, index): FlowNodePortDefinition[] => {
		if (candidate === null || typeof candidate !== "object") return [];
		const record = candidate as Record<string, unknown>;
		if (typeof record.id !== "string" || typeof record.label !== "string") return [];
		const dataType = record.dataType === "json" || record.dataType === "artifact" ? record.dataType : "text";
		return [input(record.id, record.label, [dataType], true, index === 0)];
	});
	return [...inputs, ...base.filter((port): boolean => port.direction === "output")];
}

export function getFlowNodePort(node: Pick<FlowDocumentNode, "type" | "config">, portId: string, direction: "input" | "output"): FlowNodePortDefinition | undefined {
	return resolveFlowNodePorts(node).find((port): boolean => port.id === portId && port.direction === direction);
}

export function areFlowPortsCompatible(source: FlowNodePortDefinition, target: FlowNodePortDefinition, dataType: "text" | "json" | "artifact"): boolean {
	return source.direction === "output"
		&& target.direction === "input"
		&& source.dataTypes.includes(dataType)
		&& target.dataTypes.includes(dataType);
}
