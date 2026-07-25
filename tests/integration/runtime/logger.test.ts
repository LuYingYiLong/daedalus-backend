import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeLogger, logger, redactForLog } from "../../../src/logger.js";

test("logger redacts secrets and clips large values", (): void => {
	const redacted = redactForLog({
		apiKey: "sk-secret",
		headers: {
			Authorization: "Bearer abc",
			"x-safe": "ok"
		},
		nested: {
			customSecret: "value",
			refreshToken: "token-value",
			password: "pass-value"
		},
		longText: "x".repeat(2500)
	}) as Record<string, unknown>;

	assert.equal(redacted.apiKey, "[redacted]");
	const headers = redacted.headers as Record<string, unknown>;
	assert.equal(headers.Authorization, "[redacted]");
	assert.equal(headers["x-safe"], "ok");
	const nested = redacted.nested as Record<string, unknown>;
	assert.equal(nested.customSecret, "[redacted]");
	assert.equal(nested.refreshToken, "[redacted]");
	assert.equal(nested.password, "[redacted]");
	assert.match(String(redacted.longText), /\[truncated 500 chars\]$/);
});

test("logger rotates files and caps retained backend logs", async (): Promise<void> => {
	const logDir: string = await mkdtemp(join(tmpdir(), "daedalus-logger-"));
	const previousDirectory: string | undefined = process.env.DAEDALUS_LOG_DIR;
	const previousFileLimit: string | undefined = process.env.DAEDALUS_LOG_MAX_FILE_BYTES;
	const previousTotalLimit: string | undefined = process.env.DAEDALUS_LOG_MAX_TOTAL_BYTES;
	const previousLogLevel: string | undefined = process.env.DAEDALUS_LOG_LEVEL;

	await closeLogger();
	process.env.DAEDALUS_LOG_DIR = logDir;
	process.env.DAEDALUS_LOG_MAX_FILE_BYTES = "1536";
	process.env.DAEDALUS_LOG_MAX_TOTAL_BYTES = "3072";
	process.env.DAEDALUS_LOG_LEVEL = "info";
	try {
		for (let index: number = 0; index < 8; index += 1) {
			logger.info("test", "rotation", { index, payload: "x".repeat(1200) });
		}
		await closeLogger();

		const files: string[] = (await readdir(logDir)).filter((name: string): boolean => /^backend-.+\.log$/.test(name));
		assert.ok(files.length >= 2);
		const sizes: number[] = await Promise.all(files.map(async (name: string): Promise<number> => (await stat(join(logDir, name))).size));
		assert.ok(sizes.every((size: number): boolean => size <= 1536));
		assert.ok(sizes.reduce((total: number, size: number): number => total + size, 0) <= 3072);
	} finally {
		await closeLogger();
		if (previousDirectory === undefined) {
			delete process.env.DAEDALUS_LOG_DIR;
		} else {
			process.env.DAEDALUS_LOG_DIR = previousDirectory;
		}
		if (previousFileLimit === undefined) {
			delete process.env.DAEDALUS_LOG_MAX_FILE_BYTES;
		} else {
			process.env.DAEDALUS_LOG_MAX_FILE_BYTES = previousFileLimit;
		}
		if (previousTotalLimit === undefined) {
			delete process.env.DAEDALUS_LOG_MAX_TOTAL_BYTES;
		} else {
			process.env.DAEDALUS_LOG_MAX_TOTAL_BYTES = previousTotalLimit;
		}
		if (previousLogLevel === undefined) {
			delete process.env.DAEDALUS_LOG_LEVEL;
		} else {
			process.env.DAEDALUS_LOG_LEVEL = previousLogLevel;
		}
		await rm(logDir, { recursive: true, force: true });
	}
});
