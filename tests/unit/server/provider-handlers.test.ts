import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import { saveProviderConfig } from "../../../src/providers/provider-config-store.js";
import type { ClientRequest } from "../../../src/protocol/types.js";
import { resolveModelProfile } from "../../../src/tokens/model-profiles.js";
import { createClientSession, type ClientSession } from "../../../src/server/client-session.js";
import { handleProviderRequest } from "../../../src/server/handlers/provider-handlers.js";
import { installMemorySecretStore, resetSecretStoreDriver } from "../../helpers/secret-store.js";

function createSocket(): WebSocket {
	return {
		readyState: WebSocket.OPEN,
		send: (): void => undefined,
	} as unknown as WebSocket;
}

test("provider settings reads and task-routing writes do not replace an active session model", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-provider-handlers-"));
	process.env.USERPROFILE = appDataDir;
	installMemorySecretStore();

	try {
		await saveProviderConfig({
			provider: "deepseek",
			apiKey: "deepseek-key",
			model: "deepseek-v4-flash",
		});
		await saveProviderConfig({
			provider: "moonshot",
			apiKey: "moonshot-key",
			model: "moonshot-v1-128k",
		});

		const session: ClientSession = createClientSession(undefined);
		session.sessionId = "session-provider-handler";
		session.activeProvider = "deepseek";
		session.providerModel = "deepseek-v4-flash";
		session.modelProfile = resolveModelProfile("deepseek", "deepseek-v4-flash");
		const socket: WebSocket = createSocket();
		const mcpHost: McpHost = {} as McpHost;

		await handleProviderRequest(socket, {
			type: "request",
			id: "provider-selection-read",
			method: "provider.modelSelection.get",
		} as ClientRequest, session, mcpHost);
		assert.equal(session.activeProvider, "deepseek");
		assert.equal(session.providerModel, "deepseek-v4-flash");

		await handleProviderRequest(socket, {
			type: "request",
			id: "provider-routing-write",
			method: "provider.config.set",
			params: {
				provider: "deepseek",
				activate: false,
				modelRouting: {
					imageRecognition: {
						provider: "deepseek",
						model: "deepseek-v4-flash-vision-exp",
					},
				},
			},
		} as ClientRequest, session, mcpHost);
		assert.equal(session.activeProvider, "deepseek");
		assert.equal(session.providerModel, "deepseek-v4-flash");
	} finally {
		resetSecretStoreDriver();
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(appDataDir, { recursive: true, force: true });
	}
});
