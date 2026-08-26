import readline from "node:readline";

if (process.argv.includes("--version")) {
	process.stdout.write("0.0.1\n");
	process.exit(0);
}

const registry = {
	tools: [{ name: "fixture_echo", title: "Fixture echo", description: "Echo a value.", inputSchema: { type: "object" }, risk: "read", workflow: false, global: true }],
	skills: [],
	hooks: [],
	mcpServers: []
};

function write(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

write({ jsonrpc: "2.0", method: "bridge.loaded", params: { protocolVersion: 2 } });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
	if (line.trim().length === 0) return;
	const request = JSON.parse(line);
	if (request.method === "initialize") {
    write({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 2 } });
    write({ jsonrpc: "2.0", method: "ready", params: { protocolVersion: 2, harnessVersion: "0.0.1", registry } });
		return;
	}
	if (request.method === "invoke") {
		write({ jsonrpc: "2.0", id: request.id, result: { echoed: request.params?.args?.value ?? null } });
		return;
	}
	if (request.method === "shutdown") {
		write({ jsonrpc: "2.0", id: request.id, result: {} });
		input.close();
		return;
	}
	write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found." } });
});
