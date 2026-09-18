export function register(api) {
	api.flowNodes.register({
		typeId: "fixture/cancellable",
		pluginId: "fixture",
		pluginVersion: "1.0.0",
		configVersion: 1,
		category: "test",
		workspaceRequired: false,
		sideEffecting: false,
		executable: true,
		cachePolicy: "never",
		defaultTitle: "Cancellable",
		defaultConfig: {},
		configSchema: { type: "object", additionalProperties: false },
		summaryFields: [],
		ui: { kind: "schema" },
		parameters: [],
		outputs: [{ id: "output", label: "Output", dataTypes: ["text"], defaultConnect: true }],
	}, async ({ config, signal, host }) => {
		if (typeof config.hostTool === "string") return { output: await host.callTool(config.hostTool, config.hostArgs ?? {}) };
		return await new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve({ output: "late" }), 5_000);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new Error("fixture cancelled"));
		}, { once: true });
		});
	});
}
