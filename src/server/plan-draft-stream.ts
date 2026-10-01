/** Extract only the top-level planMarkdown JSON string from a partial planner response. */
export function extractPlanMarkdownDraft(raw: string): string | null {
	let depth = 0;
	for (let index = 0; index < raw.length;) {
		const char = raw[index];
		if (char === '"') {
			const tokenStart = index;
			index += 1;
			let escaped = false;
			while (index < raw.length) {
				const current = raw[index];
				if (escaped) {
					escaped = false;
				} else if (current === "\\") {
					escaped = true;
				} else if (current === '"') {
					break;
				}
				index += 1;
			}
			if (index >= raw.length) return null;
			const tokenEnd = index;
			index += 1;
			if (depth !== 1) continue;
			let key: string;
			try {
				key = JSON.parse(raw.slice(tokenStart, tokenEnd + 1)) as string;
			} catch {
				continue;
			}
			if (key !== "planMarkdown") continue;
			while (/\s/u.test(raw[index] ?? "") && index < raw.length) index += 1;
			if (raw[index] !== ":") continue;
			index += 1;
			while (/\s/u.test(raw[index] ?? "") && index < raw.length) index += 1;
			if (raw[index] !== '"') return null;
			return decodePartialJsonString(raw, index + 1);
		}
		if (char === "{" || char === "[") depth += 1;
		else if (char === "}" || char === "]") depth -= 1;
		index += 1;
	}
	return null;
}

function decodePartialJsonString(raw: string, start: number): string {
	let result = "";
	for (let index = start; index < raw.length && result.length < 200_000; index += 1) {
		const char = raw[index];
		if (char === '"') break;
		if (char !== "\\") {
			result += char;
			continue;
		}
		const escaped = raw[++index];
		if (escaped === undefined) break;
		if (escaped === "u") {
			const digits = raw.slice(index + 1, index + 5);
			if (!/^[\da-fA-F]{4}$/u.test(digits)) break;
			result += String.fromCharCode(Number.parseInt(digits, 16));
			index += 4;
			continue;
		}
		const substitutions: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
		if (substitutions[escaped] === undefined) break;
		result += substitutions[escaped];
	}
	return result;
}
