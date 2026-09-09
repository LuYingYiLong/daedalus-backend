import { availableParallelism, totalmem } from "node:os";
import type { SubagentGraphSnapshot, SubagentNode } from "../workflow/subagent-graph.js";
import type { SubagentResourceCoordinator, SubagentResourceDecision } from "../workflow/subagent-resources.js";

type ActiveLease = { worktree: boolean; terminal: boolean };

/** 基于当前主机压力和可用并行度的运行时资源闸门。具体 provider 限流仍由错误分类触发退避。 */
export class AdaptiveSubagentResourceCoordinator implements SubagentResourceCoordinator {
	private readonly active = new Map<string, ActiveLease>();

	private key(node: SubagentNode): string {
		return `${node.graphId}:${node.nodeId}`;
	}

	acquire(node: SubagentNode, _snapshot: SubagentGraphSnapshot): SubagentResourceDecision {
		const memory = process.memoryUsage();
		const heapPressure = memory.heapTotal > 0 ? memory.heapUsed / memory.heapTotal : 0;
		const rssPressure = totalmem() > 0 ? memory.rss / totalmem() : 0;
		if (heapPressure >= 0.9 || rssPressure >= 0.9) return { available: false, reason: "system_pressure" };

		const parallelism: number = Math.max(1, availableParallelism());
		const activeValues: ActiveLease[] = [...this.active.values()];
		const usesTerminal: boolean = node.toolScope.capabilities.includes("execute");
		const usesWorktree: boolean = node.workspaceMode === "managed_worktree";
		if (usesWorktree && activeValues.filter((lease): boolean => lease.worktree).length >= parallelism) {
			return { available: false, reason: "worktree_capacity" };
		}
		if (usesTerminal && activeValues.filter((lease): boolean => lease.terminal).length >= parallelism) {
			return { available: false, reason: "terminal_capacity" };
		}
		if (activeValues.length >= parallelism * 2) return { available: false, reason: "provider_capacity" };

		this.active.set(this.key(node), { worktree: usesWorktree, terminal: usesTerminal });
		return {
			available: true,
			lease: {
				release: (): void => {
					this.active.delete(this.key(node));
				}
			}
		};
	}
}

export const adaptiveSubagentResources = new AdaptiveSubagentResourceCoordinator();
