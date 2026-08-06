import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowSemanticsMigrationError, migratePendingWorkflowRunState } from "../../../src/workflow/semantics-migration.js";
import type { WorkflowRunState } from "../../../src/workflow/types.js";

function createState(): WorkflowRunState {
	return {
		plan: {
			id: "workflow-old", title: "old", phases: [{ id: "write", title: "write", toolGroup: "write", toolBudget: "normal", allowedTools: [], instruction: "write", completionContract: { targets: [{ kind: "artifact", path: "src/a.ts" }], requireAll: true } }], todos: []
		},
		phaseIndex: 0,
		phaseOutputs: [],
		originalParams: { message: "test" },
		history: [],
		historyBudgetTokens: 0
	};
}

test("pending workflows without target semantics are blocked instead of guessed", (): void => {
	assert.throws((): WorkflowRunState => migratePendingWorkflowRunState(createState()), WorkflowSemanticsMigrationError);
});

test("fully structural pending workflow is marked as semantics v2", (): void => {
	const state = createState();
	state.plan.phases[0]!.completionContract!.targets[0] = { kind: "artifact", path: "src/a.ts", targetKind: "workspace_file" };
	const migrated = migratePendingWorkflowRunState(state);
	assert.equal(migrated.plan.semanticsVersion, 2);
	assert.equal(migrated.plan.phases[0]!.writeRequirement, "write");
});
