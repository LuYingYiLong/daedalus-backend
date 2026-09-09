import type { SubagentGraphSnapshot, SubagentNode, SubagentQueueReason } from "./subagent-graph.js";

export type SubagentResourceLease = {
	release: () => void | Promise<void>;
};

export type SubagentResourceDecision =
	| { available: true; lease: SubagentResourceLease }
	| { available: false; reason: SubagentQueueReason };

export type SubagentResourceCoordinator = {
	acquire: (node: SubagentNode, snapshot: SubagentGraphSnapshot) => Promise<SubagentResourceDecision> | SubagentResourceDecision;
};

/** 默认协调器只负责保持 lease 生命周期，具体 provider/worktree/terminal 管控由 runtime 注入。 */
export const alwaysAvailableSubagentResources: SubagentResourceCoordinator = {
	acquire: (): SubagentResourceDecision => ({
		available: true,
		lease: { release: (): void => undefined }
	})
};

