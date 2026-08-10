import assert from "node:assert/strict";
import test from "node:test";
import {
	CONTEXT_AUTO_COMPACT_PERCENT,
	CONTEXT_EMERGENCY_PERCENT,
	CONTEXT_NUDGE_PERCENT,
	createContextBudgetSnapshot,
	getContextTargetTokens
} from "../../../src/context/context-budget-manager.js";

test("context budget manager separates input, output reserve, safety margin, and available space", (): void => {
	const snapshot = createContextBudgetSnapshot({
		inputTokens: 45_000,
		outputReserveTokens: 10_000,
		safetyMarginTokens: 5_000,
		contextWindowTokens: 100_000
	});
	assert.equal(snapshot.committedTokens, 60_000);
	assert.equal(snapshot.availableTokens, 40_000);
	assert.equal(snapshot.inputPercent, 45);
	assert.equal(snapshot.outputReservePercent, 10);
	assert.equal(snapshot.safetyMarginPercent, 5);
	assert.equal(snapshot.shouldNudge, true);
	assert.equal(snapshot.shouldAutoCompress, false);
	assert.equal(getContextTargetTokens(100_000), 50_000);
});

test("context budget manager applies hysteresis thresholds deterministically", (): void => {
	for (const [percent, expected] of [
		[CONTEXT_NUDGE_PERCENT, [true, false, false]],
		[CONTEXT_AUTO_COMPACT_PERCENT, [true, true, false]],
		[CONTEXT_EMERGENCY_PERCENT, [true, true, true]]
	] as const) {
		const snapshot = createContextBudgetSnapshot({
			inputTokens: percent,
			outputReserveTokens: 0,
			safetyMarginTokens: 0,
			contextWindowTokens: 100
		});
		assert.deepEqual(
			[snapshot.shouldNudge, snapshot.shouldAutoCompress, snapshot.shouldEmergencyCompress],
			expected
		);
	}
});
