import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installReadOnlySecretStore, resetSecretStoreDriver } from "../../helpers/secret-store.js";
import { applyProviderConfigToRuntime, ensureProviderConfigured, type ProviderSessionRuntime } from "../../../src/application/provider-session-service.js";
import { saveProviderConfig } from "../../../src/providers/provider-config-store.js";
import { getDefaultModelProfile } from "../../../src/tokens/model-profiles.js";

function createRuntime(): ProviderSessionRuntime {
	return {
		activeProvider: "deepseek",
		providerApiKey: "deepseek-key",
		providerModel: "deepseek-v4-pro",
		providerBaseUrl: "https://api.deepseek.com/v1",
		modelProfile: getDefaultModelProfile("deepseek")
	};
}

test("switching provider without a key clears the previous runtime credential", (): void => {
	const runtime: ProviderSessionRuntime = createRuntime();

	applyProviderConfigToRuntime(runtime, {
		provider: "zhipu",
		model: "glm-5.3"
	});

	assert.equal(runtime.activeProvider, "zhipu");
	assert.equal(runtime.providerModel, "glm-5.3");
	assert.equal(runtime.providerApiKey, undefined);
	assert.equal(runtime.providerBaseUrl, undefined);
	assert.equal(runtime.modelProfile.provider, "zhipu");
	assert.equal(runtime.modelProfile.model, "glm-5.3");
});

test("ensuring provider credentials preserves the session selected model", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-provider-session-"));
	process.env.USERPROFILE = appDataDir;
	installReadOnlySecretStore(async (): Promise<string | null> => "moonshot-key");

	try {
		await saveProviderConfig({
			provider: "moonshot",
			model: "moonshot-v1-128k",
			baseUrl: "https://api.moonshot.cn/v1",
			apiKey: "moonshot-key"
		});
		const runtime: ProviderSessionRuntime = {
			activeProvider: "moonshot",
			providerModel: "kimi-k3",
			modelProfile: getDefaultModelProfile("moonshot")
		};

		const apiKey: string | undefined = await ensureProviderConfigured(runtime);

		assert.equal(apiKey, "moonshot-key");
		assert.equal(runtime.providerModel, "kimi-k3");
		assert.equal(runtime.modelProfile.provider, "moonshot");
		assert.equal(runtime.modelProfile.model, "kimi-k3");
		assert.equal(runtime.providerBaseUrl, "https://api.moonshot.cn/v1");
	} finally {
		resetSecretStoreDriver();
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
	}
});

test("ensuring provider credentials uses activeModel instead of a provider-local task model", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-provider-session-active-model-"));
	process.env.USERPROFILE = appDataDir;
	installReadOnlySecretStore(async (): Promise<string | null> => "deepseek-key");

	try {
		await saveProviderConfig({
			provider: "deepseek",
			model: "deepseek-v4-flash",
			apiKey: "deepseek-key",
		});
		await saveProviderConfig({
			provider: "deepseek",
			model: "deepseek-v4-flash-vision-exp",
			activate: false,
		});
		const runtime: ProviderSessionRuntime = {
			activeProvider: "deepseek",
			modelProfile: getDefaultModelProfile("deepseek"),
		};

		const apiKey: string | undefined = await ensureProviderConfigured(runtime);

		assert.equal(apiKey, "deepseek-key");
		assert.equal(runtime.providerModel, "deepseek-v4-flash");
		assert.equal(runtime.modelProfile.model, "deepseek-v4-flash");
	} finally {
		resetSecretStoreDriver();
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
	}
});
