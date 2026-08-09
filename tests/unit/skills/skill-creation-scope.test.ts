import assert from "node:assert/strict";
import test from "node:test";
import {
	normalizeSkillCreationScopeInput,
	resolveSkillCreationScope
} from "../../../src/mcp/skills/registration.js";
import { GLOBAL_SKILL_WORKSPACE_ID } from "../../../src/skills/runtime.js";

test("skill creation accepts finite scope aliases without weakening unknown-value validation", (): void => {
	assert.equal(normalizeSkillCreationScopeInput("workspace"), "project");
	assert.equal(normalizeSkillCreationScopeInput(" repository "), "project");
	assert.equal(normalizeSkillCreationScopeInput("user"), "personal");
	assert.equal(normalizeSkillCreationScopeInput("GLOBAL"), "personal");
	assert.equal(normalizeSkillCreationScopeInput("team"), "team");
	assert.equal(normalizeSkillCreationScopeInput(42), 42);
});

test("skill creation defaults scope from the structured workspace context", (): void => {
	assert.equal(resolveSkillCreationScope(undefined, {
		id: "project-workspace",
		rootPath: "C:/workspace"
	}), "project");
	assert.equal(resolveSkillCreationScope(undefined, {
		id: GLOBAL_SKILL_WORKSPACE_ID,
		rootPath: "C:/users/example/.daedalus"
	}), "personal");
});
