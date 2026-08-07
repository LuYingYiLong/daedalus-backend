import { StructuredToolError } from "../../../tools/tool-failure.js";

export type TscnSection = {
	name: string;
	attrs: Record<string, string>;
	type: string;
	attributes: Record<string, string>;
	lineIndex?: number | undefined;
};

export type TscnExtResource = {
	id: string;
	type: string;
	path: string | undefined;
	uid: string | undefined;
};

export type TscnSubResource = {
	id: string;
	type: string;
	properties: Record<string, string>;
};

export type TscnNode = {
	name: string;
	type: string;
	parent: string | null;
	properties: Record<string, string>;
	script: string | null;
	instance: string | null;
};

export type TscnConnection = {
	signal: string;
	from: string;
	to: string;
	method: string;
	flags: number | null;
	binds: string | null;
};

export type TscnData = {
	header: TscnSection | null;
	format: number;
	loadSteps: number;
	uid: string | null;
	extResources: TscnExtResource[];
	subResources: TscnSubResource[];
	nodes: TscnNode[];
	connections: TscnConnection[];
};

export type SceneScriptReferenceValidationResult = {
	ok: boolean;
	errors: string[];
	missingUniqueNames: string[];
	missingNodePaths: string[];
	missingSignalTargets: string[];
	missingSignalMethods: string[];
};

export type ScenePatchOperation =
	| {
		type: "add_node";
		parentPath: string;
		nodeType: string;
		nodeName: string;
		properties?: Record<string, string>;
	}
	| {
		type: "attach_script";
		nodePath: string;
		scriptPath: string;
	}
	| {
		type: "connect_signal";
		signal: string;
		fromNode: string;
		toNode: string;
		method: string;
		flags?: number;
		binds?: string;
	};

export function parseSectionHeader(line: string): TscnSection | null {
	const match = line.match(/^\[([^\]]+)\](.*)$/);
	if (match === null) return null;
	const sectionContent: string = match[1]!.trim();
	const firstWhitespaceIndex: number = sectionContent.search(/\s/);
	const name: string = firstWhitespaceIndex === -1
		? sectionContent
		: sectionContent.slice(0, firstWhitespaceIndex);
	const attrs: Record<string, string> = {};
	const attrStr: string = firstWhitespaceIndex === -1
		? match[2]!.trim()
		: sectionContent.slice(firstWhitespaceIndex + 1).trim();
	if (attrStr.length > 0) {
		const attrRegex = /(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g;
		let attrMatch;
		while ((attrMatch = attrRegex.exec(attrStr)) !== null) {
			let value = attrMatch[2]!;
			if (value.startsWith('"') && value.endsWith('"')) {
				value = value.slice(1, -1);
			}
			attrs[attrMatch[1]!] = value;
		}
	}
	return { name, attrs, type: name, attributes: attrs };
}

export function parseTscn(content: string): TscnData {
	const lines = content.split("\n");
	const data: TscnData = {
		header: null,
		format: 0,
		loadSteps: 0,
		uid: null,
		extResources: [],
		subResources: [],
		nodes: [],
		connections: []
	};

	let currentSection: string | null = null;
	let currentSubResourceProps: Record<string, string> = {};
	let currentSubResourceId = "";
	let currentSubResourceType = "";

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		if (line.length === 0 || line.startsWith(";")) continue;

		const section = parseSectionHeader(line);
		if (section !== null) {
			// Flush any pending sub-resource
			if (currentSection === "sub_resource" && currentSubResourceId.length > 0) {
				data.subResources.push({
					id: currentSubResourceId,
					type: currentSubResourceType,
					properties: { ...currentSubResourceProps }
				});
				currentSubResourceProps = {};
				currentSubResourceId = "";
				currentSubResourceType = "";
			}

			currentSection = section.name;

			if (section.name === "gd_scene") {
				data.header = section;
				data.format = parseInt(section.attrs["format"] ?? "0", 10);
				data.loadSteps = parseInt(section.attrs["load_steps"] ?? "0", 10);
				data.uid = section.attrs["uid"] ?? null;
			} else if (section.name === "ext_resource") {
				data.extResources.push({
					id: section.attrs["id"] ?? "",
					type: section.attrs["type"] ?? "",
					path: section.attrs["path"],
					uid: section.attrs["uid"]
				});
			} else if (section.name === "sub_resource") {
				currentSubResourceId = section.attrs["id"] ?? "";
				currentSubResourceType = section.attrs["type"] ?? "";
				currentSubResourceProps = {};
			} else if (section.name === "node") {
				data.nodes.push({
					name: section.attrs["name"] ?? "",
					type: section.attrs["type"] ?? "",
					parent: section.attrs["parent"] ?? null,
					properties: {},
					script: null,
					instance: section.attrs["instance"] ?? null
				});
			} else if (section.name === "connection") {
				data.connections.push({
					signal: section.attrs["signal"] ?? "",
					from: section.attrs["from"] ?? "",
					to: section.attrs["to"] ?? "",
					method: section.attrs["method"] ?? "",
					flags: section.attrs["flags"] !== undefined ? parseInt(section.attrs["flags"], 10) : null,
					binds: section.attrs["binds"] ?? null
				});
			}
			continue;
		}

		// Property line
		const eqIdx = line.indexOf("=");
		if (eqIdx === -1) continue;

		const key = line.slice(0, eqIdx).trim();
		const value = line.slice(eqIdx + 1).trim();

		if (currentSection === "node" && data.nodes.length > 0) {
			const lastNode = data.nodes[data.nodes.length - 1]!;
			if (key === "script" && value.startsWith('ExtResource(')) {
				lastNode.script = value;
			} else {
				lastNode.properties[key] = value;
			}
		} else if (currentSection === "sub_resource") {
			currentSubResourceProps[key] = value;
		}
	}

	// Flush final sub-resource
	if (currentSection === "sub_resource" && currentSubResourceId.length > 0) {
		data.subResources.push({
			id: currentSubResourceId,
			type: currentSubResourceType,
			properties: { ...currentSubResourceProps }
		});
	}

	return data;
}

export function quoteTscnString(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll("\"", "\\\"");
}

export function createNodePathMap(nodes: TscnNode[]): Map<string, TscnNode> {
	const pathMap: Map<string, TscnNode> = new Map();
	const rootNode: TscnNode | undefined = nodes.find((node: TscnNode): boolean => node.parent === null);
	const rootName: string | undefined = rootNode?.name;

	if (rootNode !== undefined) {
		pathMap.set(".", rootNode);
		pathMap.set(rootNode.name, rootNode);
	}

	for (const node of nodes) {
		if (node.parent === null) {
			continue;
		}

		const parentPath: string = node.parent === "." ? (rootName ?? ".") : node.parent;
		const fullPath: string = parentPath.length > 0 ? `${parentPath}/${node.name}` : node.name;
		pathMap.set(fullPath, node);

		if (node.parent === ".") {
			pathMap.set(node.name, node);
		}

		if (rootName !== undefined && !fullPath.startsWith(`${rootName}/`) && fullPath !== rootName) {
			pathMap.set(`${rootName}/${fullPath}`, node);
		}
	}

	return pathMap;
}

export function getSceneRelativeNodePath(node: TscnNode): string {
	if (node.parent === null) {
		return ".";
	}
	if (node.parent === ".") {
		return node.name;
	}
	return `${node.parent}/${node.name}`;
}

export function getExtResourceIdFromScriptValue(scriptValue: string | null): string | null {
	if (scriptValue === null) {
		return null;
	}

	const match: RegExpMatchArray | null = scriptValue.match(/^ExtResource\("([^"]+)"\)$/);
	return match === null ? null : match[1] ?? null;
}

export function toSceneRelativeNodePath(data: TscnData, nodePath: string): string {
	const normalizedPath: string = nodePath.trim().replace(/^\//, "");
	const rootNode: TscnNode | undefined = data.nodes.find((node: TscnNode): boolean => node.parent === null);
	const rootName: string | undefined = rootNode?.name;

	if (normalizedPath.length === 0 || normalizedPath === ".") {
		return ".";
	}

	if (rootName !== undefined) {
		if (normalizedPath === rootName) {
			return ".";
		}

		if (normalizedPath.startsWith(`${rootName}/`)) {
			return normalizedPath.slice(rootName.length + 1);
		}
	}

	return normalizedPath;
}

export function getNodeSectionIndex(lines: string[], targetNode: TscnNode): number {
	for (let index: number = 0; index < lines.length; index += 1) {
		const section: TscnSection | null = parseSectionHeader(lines[index]!);
		if (section === null || section.name !== "node") {
			continue;
		}

		const name: string = section.attrs["name"] ?? "";
		const type: string = section.attrs["type"] ?? "";
		const parent: string | null = section.attrs["parent"] ?? null;

		if (name === targetNode.name && type === targetNode.type && parent === targetNode.parent) {
			return index;
		}
	}

	return -1;
}

export function getNextSectionIndex(lines: string[], startIndex: number): number {
	let index: number = startIndex + 1;
	while (index < lines.length) {
		const line: string = lines[index]!.trim();
		if (line.startsWith("[")) {
			break;
		}
		index += 1;
	}

	return index;
}

export function generateSceneTscn(rootNodeType: string, rootNodeName: string): string {
	return `[gd_scene load_steps=2 format=3]

[node name="${quoteTscnString(rootNodeName)}" type="${quoteTscnString(rootNodeType)}"]
`;
}

export function findNodeInTscn(data: TscnData, targetPath: string): TscnNode | null {
	const normalizedTargetPath: string = targetPath.trim().replace(/^\//, "");
	if (normalizedTargetPath.length === 0 || normalizedTargetPath === ".") {
		return data.nodes.find(n => n.parent === null) ?? null;
	}

	return createNodePathMap(data.nodes).get(normalizedTargetPath) ?? null;
}

export function getNodeFullPath(node: TscnNode, allNodes: TscnNode[]): string {
	if (node.parent === null || node.parent === ".") return node.name;

	// Find parent
	const parent = allNodes.find(n => {
		const parentPath = n.parent === "." || n.parent === null ? "" : n.parent;
		const nodePath = parentPath.length > 0 ? `${parentPath}/${n.name}` : n.name;
		return nodePath === node.parent;
	});

	if (parent === undefined) return node.name;
	return `${getNodeFullPath(parent, allNodes)}/${node.name}`;
}

export function addNodeToSceneTscn(content: string, parentPath: string, nodeType: string, nodeName: string, properties: Record<string, string>): string {
	const data: TscnData = parseTscn(content);
	const parentNode: TscnNode | null = findNodeInTscn(data, parentPath);

	if (parentNode === null) {
		throw new Error(`Parent node not found in scene: ${parentPath}`);
	}

	const resolvedParent: string = toSceneRelativeNodePath(data, parentPath);
	const rootNode: TscnNode | undefined = data.nodes.find((node: TscnNode): boolean => node.parent === null);
	const candidateScenePath: string = resolvedParent === "." ? nodeName : `${resolvedParent}/${nodeName}`;
	const candidateFullPath: string = rootNode === undefined ? candidateScenePath : `${rootNode.name}/${candidateScenePath}`;
	const nodePathMap: Map<string, TscnNode> = createNodePathMap(data.nodes);

	if (nodePathMap.has(candidateScenePath) || nodePathMap.has(candidateFullPath)) {
		throw new Error(`Node already exists in scene: ${candidateScenePath}`);
	}

	let nodeLine = `[node name="${quoteTscnString(nodeName)}" type="${quoteTscnString(nodeType)}" parent="${quoteTscnString(resolvedParent)}"]`;
	if (Object.keys(properties).length > 0) {
		for (const [key, value] of Object.entries(properties)) {
			nodeLine += `\n${key} = ${value}`;
		}
	}
	nodeLine += "\n";

	// Insert before the last section (connections or end of file)
	const lines = content.split("\n");
	const insertIdx = findLastNodeInsertIndex(lines);
	lines.splice(insertIdx, 0, nodeLine);
	return lines.join("\n");
}

export function findLastNodeInsertIndex(lines: string[]): number {
	// Find where to insert a new node: after the last [node ...] section's properties
	let lastNodeLine = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.startsWith("[node ")) {
			lastNodeLine = i;
		}
	}

	if (lastNodeLine === -1) {
		// No nodes yet, find where [gd_scene] header ends
		for (let i = 0; i < lines.length; i++) {
			if (lines[i]!.startsWith("[gd_scene ")) {
				// Find next non-empty, non-property line after header
				let j = i + 1;
				while (j < lines.length && lines[j]!.trim().length === 0) j++;
				return j;
			}
		}
		return lines.length;
	}

	// Skip the [node ...] line and its properties
	let i = lastNodeLine + 1;
	while (i < lines.length) {
		const line = lines[i]!.trim();
		if (line.length === 0 || line.startsWith(";")) {
			i++;
			continue;
		}
		if (line.startsWith("[")) break;
		i++;
	}
	return i;
}

export function attachScriptToSceneTscn(content: string, nodePath: string, scriptPath: string): string {
	const data = parseTscn(content);
	const targetNode = findNodeInTscn(data, nodePath);

	if (targetNode === null) {
		throw new Error(`Node not found in scene: ${nodePath}`);
	}

	const extResMatch = scriptPath.match(/^ExtResource\("([^"]+)"\)$/);
	const lines = content.split("\n");
	const nodeSectionIndex: number = getNodeSectionIndex(lines, targetNode);

	if (nodeSectionIndex === -1) {
		throw new Error(`Node section not found in scene: ${nodePath}`);
	}

	const nodeSectionEndIndex: number = getNextSectionIndex(lines, nodeSectionIndex);
	for (let index: number = nodeSectionIndex + 1; index < nodeSectionEndIndex; index += 1) {
		if (lines[index]!.trim().startsWith("script =")) {
			throw new Error(`Node already has a script: ${nodePath}`);
		}
	}

	let scriptValue: string;
	if (extResMatch !== null) {
		scriptValue = scriptPath;
	} else {
		if (!scriptPath.startsWith("res://") || !scriptPath.endsWith(".gd")) {
			throw new Error("scriptPath must be a res:// path ending with .gd or an ExtResource(\"id\") reference");
		}

		const existingResource: TscnExtResource | undefined = data.extResources.find(
			(resource: TscnExtResource): boolean => resource.path === scriptPath
		);
		let resourceId: string;

		if (existingResource !== undefined) {
			resourceId = existingResource.id;
		} else {
			const usedIds: Set<string> = new Set(data.extResources.map((resource: TscnExtResource): string => resource.id));
			let nextIndex: number = data.extResources.length + 1;
			do {
				resourceId = `${nextIndex}_script`;
				nextIndex += 1;
			} while (usedIds.has(resourceId));

			const gdSceneIndex: number = lines.findIndex((line: string): boolean => line.startsWith("[gd_scene "));
			if (gdSceneIndex === -1) {
				throw new Error("Missing [gd_scene ...] header");
			}

			lines[gdSceneIndex] = lines[gdSceneIndex]!.replace(
				/load_steps=(\d+)/,
				(_match: string, value: string): string => `load_steps=${Number.parseInt(value, 10) + 1}`
			);
			lines.splice(gdSceneIndex + 1, 0, `[ext_resource type="Script" path="${quoteTscnString(scriptPath)}" id="${resourceId}"]`);
		}

		scriptValue = `ExtResource("${resourceId}")`;
	}

	const refreshedData: TscnData = parseTscn(lines.join("\n"));
	const refreshedNode: TscnNode | null = findNodeInTscn(refreshedData, nodePath);
	if (refreshedNode === null) {
		throw new Error(`Node not found after script resource update: ${nodePath}`);
	}

	const refreshedNodeSectionIndex: number = getNodeSectionIndex(lines, refreshedNode);
	lines.splice(refreshedNodeSectionIndex + 1, 0, `script = ${scriptValue}`);
	return lines.join("\n");
}

export function connectSignalInSceneTscn(content: string, signal: string, fromNode: string, toNode: string, method: string, flags?: number, binds?: string): string {
	const data: TscnData = parseTscn(content);

	if (findNodeInTscn(data, fromNode) === null) {
		throw new StructuredToolError({
			code: "signal_node_not_found",
			category: "business",
			message: `Signal source node not found in the current scene: ${fromNode}`,
			retryable: true,
			artifactRefs: [],
			details: { endpoint: "source", nodePath: fromNode, signal }
		});
	}

	if (findNodeInTscn(data, toNode) === null) {
		throw new StructuredToolError({
			code: "signal_node_not_found",
			category: "business",
			message: `Signal target node not found in the current scene: ${toNode}`,
			retryable: true,
			artifactRefs: [],
			details: { endpoint: "target", nodePath: toNode, signal }
		});
	}

	const resolvedFromNode: string = toSceneRelativeNodePath(data, fromNode);
	const resolvedToNode: string = toSceneRelativeNodePath(data, toNode);
	const connExists: boolean = data.connections.some(
		(connection: TscnConnection): boolean =>
			connection.signal === signal
			&& toSceneRelativeNodePath(data, connection.from) === resolvedFromNode
			&& toSceneRelativeNodePath(data, connection.to) === resolvedToNode
			&& connection.method === method
	);

	if (connExists) {
		throw new Error("This signal connection already exists in the scene");
	}

	let connLine = `[connection signal="${quoteTscnString(signal)}" from="${quoteTscnString(resolvedFromNode)}" to="${quoteTscnString(resolvedToNode)}" method="${quoteTscnString(method)}"`;
	if (flags !== undefined) {
		connLine += ` flags=${flags}`;
	}
	if (binds !== undefined && binds.length > 0) {
		connLine += ` binds= ${binds}`;
	}
	connLine += "]\n";

	// Find the last [connection ...] line or the end
	const lines = content.split("\n");
	let lastConnIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.startsWith("[connection ")) {
			lastConnIdx = i;
		}
	}

	if (lastConnIdx >= 0) {
		lines.splice(lastConnIdx + 1, 0, connLine);
	} else {
		lines.push(connLine);
	}

	return lines.join("\n").replace(/\n\n+$/, "\n");
}

export function applyScenePatchToTscn(content: string, operations: ScenePatchOperation[]): {
	content: string;
	applied: Array<Record<string, unknown>>;
} {
	let nextContent: string = content;
	const applied: Array<Record<string, unknown>> = [];

	for (const operation of operations) {
		if (operation.type === "add_node") {
			nextContent = addNodeToSceneTscn(
				nextContent,
				operation.parentPath,
				operation.nodeType,
				operation.nodeName,
				operation.properties ?? {}
			);
			applied.push({
				type: operation.type,
				parentPath: operation.parentPath,
				nodeType: operation.nodeType,
				nodeName: operation.nodeName
			});
		} else if (operation.type === "attach_script") {
			nextContent = attachScriptToSceneTscn(nextContent, operation.nodePath, operation.scriptPath);
			applied.push({
				type: operation.type,
				nodePath: operation.nodePath,
				scriptPath: operation.scriptPath
			});
		} else if (operation.type === "connect_signal") {
			nextContent = connectSignalInSceneTscn(
				nextContent,
				operation.signal,
				operation.fromNode,
				operation.toNode,
				operation.method,
				operation.flags,
				operation.binds
			);
			applied.push({
				type: operation.type,
				signal: operation.signal,
				fromNode: operation.fromNode,
				toNode: operation.toNode,
				method: operation.method
			});
		} else {
			const unreachable: never = operation;
			throw new Error(`Unsupported scene patch operation: ${JSON.stringify(unreachable)}`);
		}
	}

	return { content: nextContent, applied };
}

export function validateTscnContent(content: string): string[] {
	const errors: string[] = [];
	const trimmedContent: string = content.trimStart();
	if (!/^\[gd_scene\s/.test(trimmedContent)) {
		errors.push("TSCN file must start with [gd_scene ...] header");
	}
	if (!/^\[node\s/m.test(trimmedContent)) {
		errors.push("TSCN file must contain at least one [node ...] section (root node)");
	}
	return errors;
}

function collectUniqueNodeNames(data: TscnData): Set<string> {
	const names: Set<string> = new Set();
	for (const node of data.nodes) {
		if (node.properties.unique_name_in_owner === "true") {
			names.add(node.name);
		}
	}
	return names;
}

function collectRegexMatches(text: string, pattern: RegExp): string[] {
	const values: string[] = [];
	for (const match of text.matchAll(pattern)) {
		const value: string | undefined = match[1];
		if (value !== undefined && value.length > 0) {
			values.push(value);
		}
	}
	return [...new Set(values)];
}

function stripGdscriptStringsAndComments(scriptContent: string): string {
	let result: string = "";
	let index: number = 0;
	let isInString: boolean = false;
	let isTripleQuoted: boolean = false;

	while (index < scriptContent.length) {
		const character: string = scriptContent[index] ?? "";
		const nextThreeCharacters: string = scriptContent.slice(index, index + 3);

		if (isInString) {
			if (isTripleQuoted && nextThreeCharacters === '\"\"\"') {
				result += "   ";
				index += 3;
				isInString = false;
				isTripleQuoted = false;
				continue;
			}
			if (!isTripleQuoted && character === "\\") {
				result += " ";
				index += 1;
				if (index < scriptContent.length) {
					result += scriptContent[index] === "\n" ? "\n" : " ";
					index += 1;
				}
				continue;
			}
			if (!isTripleQuoted && character === '\"') {
				result += " ";
				index += 1;
				isInString = false;
				continue;
			}
			result += character === "\n" ? "\n" : " ";
			index += 1;
			continue;
		}

		if (character === "#") {
			while (index < scriptContent.length && scriptContent[index] !== "\n") {
				result += " ";
				index += 1;
			}
			continue;
		}
		if (nextThreeCharacters === '\"\"\"') {
			result += "   ";
			index += 3;
			isInString = true;
			isTripleQuoted = true;
			continue;
		}
		if (character === '\"') {
			result += " ";
			index += 1;
			isInString = true;
			continue;
		}

		result += character;
		index += 1;
	}

	return result;
}

function hasGdscriptFunction(scriptContent: string, method: string): boolean {
	const escapedMethod: string = method.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|\\n)\\s*func\\s+${escapedMethod}\\s*\\(`).test(scriptContent);
}

function formatSignalMethodReference(nodePath: string, method: string): string {
	return nodePath === "." ? `.${method}` : `${nodePath}.${method}`;
}

function resolveScriptNodeReferencePath(data: TscnData, scriptNodePath: string, referencedPath: string): string {
	const relativeScriptNodePath: string = toSceneRelativeNodePath(data, scriptNodePath);
	return relativeScriptNodePath === "."
		? referencedPath
		: `${relativeScriptNodePath}/${referencedPath}`;
}

export function validateSceneScriptReferences(
	sceneContent: string,
	scriptContentByNodePath: Record<string, string> = {}
): SceneScriptReferenceValidationResult {
	const data: TscnData = parseTscn(sceneContent);
	const uniqueNodeNames: Set<string> = collectUniqueNodeNames(data);
	const missingUniqueNames: string[] = [];
	const missingNodePaths: string[] = [];
	const missingSignalTargets: string[] = [];
	const missingSignalMethods: string[] = [];

	for (const [nodePath, scriptContent] of Object.entries(scriptContentByNodePath)) {
		const referenceContent: string = stripGdscriptStringsAndComments(scriptContent);
		for (const nodeName of collectRegexMatches(referenceContent, /%([A-Za-z_][A-Za-z0-9_]*)/g)) {
			if (!uniqueNodeNames.has(nodeName)) {
				missingUniqueNames.push(`${nodePath}: %${nodeName}`);
			}
		}

		for (const referencedPath of collectRegexMatches(referenceContent, /\$([A-Za-z_][A-Za-z0-9_\/]*)/g)) {
			const resolvedPath: string = resolveScriptNodeReferencePath(data, nodePath, referencedPath);
			if (findNodeInTscn(data, resolvedPath) === null) {
				missingNodePaths.push(`${nodePath}: $${referencedPath}`);
			}
		}
	}

	for (const connection of data.connections) {
		if (findNodeInTscn(data, connection.from) === null) {
			missingSignalTargets.push(`${connection.signal}: from ${connection.from}`);
		}
		if (findNodeInTscn(data, connection.to) === null) {
			missingSignalTargets.push(`${connection.signal}: to ${connection.to}`);
			continue;
		}
		const targetScript: string | undefined = scriptContentByNodePath[connection.to];
		if (targetScript !== undefined && !hasGdscriptFunction(targetScript, connection.method)) {
			missingSignalMethods.push(formatSignalMethodReference(connection.to, connection.method));
		}
	}

	const errors: string[] = [
		...missingUniqueNames.map((item: string): string => `Missing unique_name_in_owner for script reference ${item}`),
		...missingNodePaths.map((item: string): string => `Missing node path for script reference ${item}`),
		...missingSignalTargets.map((item: string): string => `Missing signal connection node ${item}`),
		...missingSignalMethods.map((item: string): string => `Missing signal target method ${item}`)
	];

	return {
		ok: errors.length === 0,
		errors,
		missingUniqueNames: [...new Set(missingUniqueNames)],
		missingNodePaths: [...new Set(missingNodePaths)],
		missingSignalTargets: [...new Set(missingSignalTargets)],
		missingSignalMethods: [...new Set(missingSignalMethods)]
	};
}
