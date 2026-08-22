export function register(api) {
	api.commands.register(
		{ id: "hello", command: "/fixture-hello", description: "Insert a fixture greeting.", handlerName: "fixture.command.hello" },
		() => ({ prompt: "Hello from the fixture plugin." }),
	);
	api.contextProviders.register(
		{ id: "context", title: "Fixture context", description: "Provides a safe fixture context item.", scopes: ["plugin"], handlerName: "fixture.context" },
		() => ({ title: "Fixture context", content: "Safe fixture context." }),
	);
	api.tools.register(
		{
			name: "fixture_echo",
			title: "Fixture echo",
			description: "Returns the supplied fixture text.",
			inputSchema: {
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
			},
			risk: "read",
			workflow: true,
			global: true,
		},
		(args) => ({ echo: args.text }),
	);
	api.skills.register({
		slug: "fixture",
		name: "Fixture skill",
		description: "A skill used by the native plugin fixture.",
		body: "Use fixture_echo when a plugin runtime smoke test is requested.",
		allowedTools: ["fixture_echo"],
	});
	api.hooks.register(
		{
			event: "SessionStart",
			matcher: "*",
			async: false,
			failurePolicy: "continue",
		},
		() => ({ additionalContext: "Native fixture hook is active." }),
	);
	api.mcp.register(
		{
			serverId: "fixture",
			serverName: "Fixture MCP",
			tools: [{ name: "ping", description: "Returns pong.", inputSchema: { type: "object" }, risk: "read" }],
			resources: [],
		},
		{ tools: { ping: () => ({ value: "pong" }) } },
	);
}
