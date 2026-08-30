import type WebSocket from "ws";
import type { ClientRequest } from "../protocol/types.js";
import type { McpHost } from "../mcp/mcp-host.js";
import type { ClientSession } from "./client-session.js";

export type RequestHandler = (
	socket: WebSocket,
	request: ClientRequest,
	session: ClientSession,
	mcpHost: McpHost
) => Promise<void> | void;

function createLazyHandler(loadHandler: () => Promise<RequestHandler>): RequestHandler {
	let handlerPromise: Promise<RequestHandler> | null = null;
	return async (socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> => {
		if (handlerPromise === null) {
			handlerPromise = loadHandler();
		}
		const handler: RequestHandler = await handlerPromise;
		await handler(socket, request, session, mcpHost);
	};
}

const handleCoreRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/core-handlers.js")).handleCoreRequest;
});

const handleClientRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/client-handlers.js")).handleClientRequest;
});

const handleProviderRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/provider-handlers.js")).handleProviderRequest;
});

const handleChatRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./chat-orchestrator.js")).handleChatRequest;
});

const handleSessionRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./session-rpc-handlers.js")).handleSessionRequest;
});

const handleGuideRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/guide-handlers.js")).handleGuideRequest;
});

const handleWorkbenchRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/workbench-handlers.js")).handleWorkbenchRequest;
});

const handleMessageQueueRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/message-queue-handlers.js")).handleMessageQueueRequest;
});

const handleMcpRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/mcp-handlers.js")).handleMcpRequest;
});

const handleToolRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/tool-handlers.js")).handleToolRequest;
});

const handleFileChangeRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/file-change-handlers.js")).handleFileChangeRequest;
});

const handleFileEditRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/file-edit-handlers.js")).handleFileEditRequest;
});

const handleAttachmentRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/attachment-handlers.js")).handleAttachmentRequest;
});

const handlePlanRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/plan-handlers.js")).handlePlanRequest;
});

const handleApprovalRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/approval-handlers.js")).handleApprovalRequest;
});

const handleEnvironmentRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/environment-handlers.js")).handleEnvironmentRequest;
});

const handleEditorRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/editor-handlers.js")).handleEditorRequest;
});

const handleWorkspaceRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/workspace-handlers.js")).handleWorkspaceRequest;
});

const handleGodotDocumentationRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/godot-documentation-handlers.js")).handleGodotDocumentationRequest;
});

const handleSelectionAskRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/selection-ask-handlers.js")).handleSelectionAskRequest;
});

const handleGoalRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/goal-handlers.js")).handleGoalRequest;
});

const handleHookRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/hook-handlers.js")).handleHookRequest;
});

const handlePluginDevelopmentRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/plugin-development-handlers.js")).handlePluginDevelopmentRequest;
});

const handlePluginMaintenanceRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/plugin-maintenance-handlers.js")).handlePluginMaintenanceRequest;
});

const handlePluginRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/plugin-handlers.js")).handlePluginRequest;
});

const handlePluginRuntimeRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/plugin-runtime-handlers.js")).handlePluginRuntimeRequest;
});

const handlePluginHarnessRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/plugin-harness-handlers.js")).handlePluginHarnessRequest;
});

const handlePluginP2Request: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/plugin-p2-handlers.js")).handlePluginP2Request;
});

export const REQUEST_HANDLER_METHODS: readonly ClientRequest["method"][] = [
	"ping",
	"backend.health",
	"backend.shutdown",
	"backend.update.check",
	"backend.update.install",
	"usage.metrics.summary.get",
	"usage.metrics.logs.list",
	"usage.metrics.trends.get",
	"command.list",
	"client.hello",
	"client.info",
	"client.capabilities.update",
	"browser.tool.result",
	"computer.tool.result",
	"computer.access.revoked",
	"computer.control.update",
	"session.computerObservation.get",
	"scheduled-task.tool.result",
	"provider.configure",
	"provider.config.get",
	"provider.current.get",
	"provider.modelSelection.get",
	"provider.config.set",
	"provider.config.clear",
	"provider.models.list",
	"provider.models.discover",
	"provider.models.import",
	"provider.models.sync",
	"provider.custom.add",
	"provider.custom.update",
	"provider.usage.get",
	"provider.setEnabled",
	"provider.custom.remove",
	"provider.model.add",
	"provider.model.update",
	"ai.chat",
	"agent.run.retry",
	"agent.goal.current",
	"agent.goal.pause",
	"agent.goal.resume",
	"agent.goal.cancel",
	"agent.goal.dismiss",
	"agent.goal.extendBudget",
	"agent.goal.rollback.preview",
	"agent.goal.rollback.apply",
	"ai.next_step_hints",
	"ai.cancel",
	"ai.toolBudget.continue",
	"ai.toolBudget.stop",
	"prompt.list",
	"userPrompt.get",
	"userPrompt.set",
	"generalSettings.get",
	"generalSettings.update",
	"hooks.config.sources.list",
	"hooks.config.get",
	"hooks.config.update",
	"hooks.trust.update",
	"hooks.runs.list",
	"godotDocumentation.get",
	"godotDocumentation.branches.list",
	"godotDocumentation.install",
	"godotDocumentation.importLocal",
	"godotDocumentation.update",
	"godotDocumentation.health.check",
	"godotDocumentation.repair",
	"godotDocumentation.remove",
	"godotDocumentation.setEnabled",
	"godotDocumentation.job.get",
	"godotDocumentation.job.cancel",
	"webSearchSettings.get",
	"webSearchSettings.update",
	"skill.list",
	"skill.get",
	"skill.set_enabled",
	"skill.update",
	"skill.remove",
	"skill.install",
	"skill.reload",
	"plugin.catalog.list",
	"plugin.scan",
	"plugin.install",
	"plugin.remove",
	"plugin.trust.update",
	"plugin.review.resolve",
	"plugin.profile.get",
	"plugin.profile.update",
	"plugin.update.install",
	"plugin.versions.list",
	"plugin.rollback",
	"plugin.runtime.list",
	"plugin.runtime.restart",
	"plugin.runtime.disable",
	"plugin.runtime.clear_quarantine",
	"plugin.runtime.logs.list",
	"plugin.runtime.dependencies.install",
	"plugin.harness.config.get",
	"plugin.harness.config.update",
	"plugin.harness.detect",
	"plugin.harness.preview",
	"plugin.harness.runtime.status",
	"plugin.extensions.registry.get",
	"plugin.command.resolve",
	"plugin.ui.panel.create",
	"plugin.ui.panel.action",
	"plugin.ui.panel.state.get",
	"plugin.ui.panel.state.update",
	"plugin.settings.state.get",
	"plugin.settings.state.update",
	"plugin.browser.invoke",
	"plugin.language-service.start",
	"plugin.language-service.stop",
	"plugin.events.publish",
	"plugin.events.subscribe",
	"plugin.events.ack",
	"plugin.timeline.append",
	"plugin.harness.convert.preview",
	"plugin.harness.convert.activate",
	"plugin.development.status.get",
	"plugin.update.preview",
	"plugin.update.operation.get",
	"plugin.update.operation.cancel",
	"plugin.development.runs.list",
	"plugin.development.runs.get",
	"plugin.changelog.generate",
	"plugin.changelog.apply",
	"plugin.release.preview",
	"plugin.release.confirm",
	"plugin.release.export",
	"plugin.publish.confirm",
	"session.reset",
	"session.info",
	"session.create",
	"session.fork",
	"session.worktree.create",
	"session.worktree.operation.get",
	"session.worktree.operation.cancel",
	"session.worktree.setup.retry",
	"session.worktree.setup.skip",
	"session.worktree.handoff.preview",
	"session.worktree.handoff.execute",
	"session.worktree.delete",
	"session.open",
	"session.subscribe",
	"session.unsubscribe",
	"session.editor.bind",
	"session.timeline",
	"session.trace.summary",
	"session.trace.page",
	"session.trace.detail",
	"session.timeline.search.index",
	"session.timeline.search.start",
	"session.timeline.search.page",
	"session.timeline.search.cancel",
	"session.selectionAsk.list",
	"session.selectionAsk.get",
	"session.selectionAsk.create",
	"session.selectionAsk.send",
	"session.selectionAsk.cancel",
	"session.selectionAsk.delete",
	"session.selectionAsk.deleteAll",
	"session.timeline.index",
	"session.integrity.check",
	"session.list",
	"session.browser.snapshot",
	"session.archive",
	"session.archived.list",
	"session.archived.restore",
	"session.archived.delete",
	"session.export",
	"session.import",
	"session.save",
	"session.model.set",
	"session.delete",
	"session.rename",
	"session.workspace.move",
	"session.pin.set",
	"session.compress",
	"session.summary",
	"session.overview.get",
	"session.context.estimate",
	"session.workflow.todo.dismiss",
	"session.workbench.get",
	"session.workbench.patch",
	"session.guide.add",
	"session.guide.update",
	"session.guide.delete",
	"session.guide.reorder",
	"message.queue.list",
	"message.queue.add",
	"message.queue.update",
	"message.queue.remove",
	"message.queue.status",
	"message.queue.reorder",
	"mcp.listTools",
	"mcp.callTool",
	"mcp.listResources",
	"mcp.readResource",
	"mcp.config.list",
	"mcp.config.add",
	"mcp.config.update",
	"mcp.config.remove",
	"mcp.config.setEnabled",
	"tool.catalog.list",
	"tool.execute",
	"fileChange.create",
	"fileChange.overwrite",
	"fileChange.delete",
	"fileEdit.batch.get",
	"attachment.image.save",
	"attachment.image.generated.get",
	"attachment.image.get",
	"attachment.text.save",
	"attachment.text.get",
	"plan.get",
	"plan.clarify",
	"plan.revise",
	"plan.approve",
	"approval.list",
	"approval.mode.set",
	"approval.approve",
	"approval.reject",
	"environment.configure",
	"environment.config.get",
	"environment.config.update",
	"environment.trust.update",
	"environment.actions.list",
	"editor.instances.list",
	"editor.context.update",
	"editor.heartbeat",
	"editor.tool.result",
	"workspace.list",
	"workspace.tree.order.get",
	"workspace.tree.order.update",
	"workspace.select",
	"workspace.update",
	"workspace.delete",
	"workspace.info",
	"workspace.worktree.eligibility.get",
	"workspace.worktree.status.list",
	"workspace.worktree.settings.get",
	"workspace.worktree.settings.update",
	"workspace.worktree.repair",
	"workspace.worktree.permanent.create",
	"workspace.worktree.permanent.delete",
	"workspace.git.diff.get",
	"workspace.git.diff.summary.get",
	"workspace.git.diff.file.get",
	"workspace.git.commit.message.generate",
	"workspace.git.commitOrPush",
	"workspace.git.branches.list",
	"workspace.git.branch.checkout",
	"workspace.git.branch.create"
] as const;

export const REQUEST_HANDLERS: ReadonlyMap<ClientRequest["method"], RequestHandler> = new Map([
	["ping", handleCoreRequest],
	["backend.health", handleCoreRequest],
	["backend.shutdown", handleCoreRequest],
	["backend.update.check", handleCoreRequest],
	["backend.update.install", handleCoreRequest],
	["usage.metrics.summary.get", handleCoreRequest],
	["usage.metrics.logs.list", handleCoreRequest],
	["usage.metrics.trends.get", handleCoreRequest],
	["command.list", handleCoreRequest],
	["client.hello", handleClientRequest],
	["client.info", handleClientRequest],
	["client.capabilities.update", handleClientRequest],
	["browser.tool.result", handleClientRequest],
	["computer.tool.result", handleClientRequest],
	["computer.access.revoked", handleClientRequest],
	["computer.control.update", handleClientRequest],
	["session.computerObservation.get", handleClientRequest],
	["scheduled-task.tool.result", handleClientRequest],
	["prompt.list", handleCoreRequest],
	["userPrompt.get", handleCoreRequest],
	["userPrompt.set", handleCoreRequest],
	["generalSettings.get", handleCoreRequest],
	["generalSettings.update", handleCoreRequest],
	["hooks.config.sources.list", handleHookRequest],
	["hooks.config.get", handleHookRequest],
	["hooks.config.update", handleHookRequest],
	["hooks.trust.update", handleHookRequest],
	["hooks.runs.list", handleHookRequest],
	["plugin.catalog.list", handlePluginRequest],
	["plugin.scan", handlePluginRequest],
	["plugin.install", handlePluginRequest],
	["plugin.remove", handlePluginRequest],
	["plugin.trust.update", handlePluginRequest],
	["plugin.review.resolve", handlePluginRequest],
	["plugin.profile.get", handlePluginRequest],
	["plugin.profile.update", handlePluginRequest],
	["plugin.update.install", handlePluginRequest],
	["plugin.versions.list", handlePluginRequest],
	["plugin.rollback", handlePluginRequest],
	["plugin.runtime.list", handlePluginRuntimeRequest],
	["plugin.runtime.restart", handlePluginRuntimeRequest],
	["plugin.runtime.disable", handlePluginRuntimeRequest],
	["plugin.runtime.clear_quarantine", handlePluginRuntimeRequest],
	["plugin.runtime.logs.list", handlePluginRuntimeRequest],
	["plugin.runtime.dependencies.install", handlePluginRuntimeRequest],
	["plugin.harness.config.get", handlePluginHarnessRequest],
	["plugin.harness.config.update", handlePluginHarnessRequest],
	["plugin.harness.detect", handlePluginHarnessRequest],
	["plugin.harness.preview", handlePluginHarnessRequest],
	["plugin.harness.runtime.status", handlePluginHarnessRequest],
	["plugin.extensions.registry.get", handlePluginP2Request],
	["plugin.command.resolve", handlePluginP2Request],
	["plugin.ui.panel.create", handlePluginP2Request],
	["plugin.ui.panel.action", handlePluginP2Request],
	["plugin.ui.panel.state.get", handlePluginP2Request],
	["plugin.ui.panel.state.update", handlePluginP2Request],
	["plugin.settings.state.get", handlePluginP2Request],
	["plugin.settings.state.update", handlePluginP2Request],
	["plugin.browser.invoke", handlePluginP2Request],
	["plugin.language-service.start", handlePluginP2Request],
	["plugin.language-service.stop", handlePluginP2Request],
	["plugin.events.publish", handlePluginP2Request],
	["plugin.events.subscribe", handlePluginP2Request],
	["plugin.events.ack", handlePluginP2Request],
	["plugin.timeline.append", handlePluginP2Request],
	["plugin.harness.convert.preview", handlePluginP2Request],
	["plugin.harness.convert.activate", handlePluginP2Request],
	["plugin.development.status.get", handlePluginDevelopmentRequest],
	["plugin.update.preview", handlePluginMaintenanceRequest],
	["plugin.update.operation.get", handlePluginMaintenanceRequest],
	["plugin.update.operation.cancel", handlePluginMaintenanceRequest],
	["plugin.development.runs.list", handlePluginMaintenanceRequest],
	["plugin.development.runs.get", handlePluginMaintenanceRequest],
	["plugin.changelog.generate", handlePluginMaintenanceRequest],
	["plugin.changelog.apply", handlePluginMaintenanceRequest],
	["plugin.release.preview", handlePluginMaintenanceRequest],
	["plugin.release.confirm", handlePluginMaintenanceRequest],
	["plugin.release.export", handlePluginMaintenanceRequest],
	["plugin.publish.confirm", handlePluginMaintenanceRequest],
	["godotDocumentation.get", handleGodotDocumentationRequest],
	["godotDocumentation.branches.list", handleGodotDocumentationRequest],
	["godotDocumentation.install", handleGodotDocumentationRequest],
	["godotDocumentation.importLocal", handleGodotDocumentationRequest],
	["godotDocumentation.update", handleGodotDocumentationRequest],
	["godotDocumentation.health.check", handleGodotDocumentationRequest],
	["godotDocumentation.repair", handleGodotDocumentationRequest],
	["godotDocumentation.remove", handleGodotDocumentationRequest],
	["godotDocumentation.setEnabled", handleGodotDocumentationRequest],
	["godotDocumentation.job.get", handleGodotDocumentationRequest],
	["godotDocumentation.job.cancel", handleGodotDocumentationRequest],
	["webSearchSettings.get", handleCoreRequest],
	["webSearchSettings.update", handleCoreRequest],
	["skill.list", handleCoreRequest],
	["skill.get", handleCoreRequest],
	["skill.set_enabled", handleCoreRequest],
	["skill.update", handleCoreRequest],
	["skill.remove", handleCoreRequest],
	["skill.install", handleCoreRequest],
	["skill.reload", handleCoreRequest],
	["provider.configure", handleProviderRequest],
	["provider.config.get", handleProviderRequest],
	["provider.current.get", handleProviderRequest],
	["provider.modelSelection.get", handleProviderRequest],
	["provider.config.set", handleProviderRequest],
	["provider.config.clear", handleProviderRequest],
	["provider.models.list", handleProviderRequest],
	["provider.models.discover", handleProviderRequest],
	["provider.models.import", handleProviderRequest],
	["provider.models.sync", handleProviderRequest],
	["provider.custom.add", handleProviderRequest],
	["provider.custom.update", handleProviderRequest],
	["provider.usage.get", handleProviderRequest],
	["provider.setEnabled", handleProviderRequest],
	["provider.custom.remove", handleProviderRequest],
	["provider.model.add", handleProviderRequest],
	["provider.model.update", handleProviderRequest],
	["ai.cancel", handleChatRequest],
	["ai.toolBudget.continue", handleChatRequest],
	["ai.toolBudget.stop", handleChatRequest],
	["ai.chat", handleChatRequest],
	["agent.run.retry", handleChatRequest],
	["agent.goal.current", handleGoalRequest],
	["agent.goal.pause", handleGoalRequest],
	["agent.goal.resume", handleGoalRequest],
	["agent.goal.cancel", handleGoalRequest],
	["agent.goal.dismiss", handleGoalRequest],
	["agent.goal.extendBudget", handleGoalRequest],
	["agent.goal.rollback.preview", handleGoalRequest],
	["agent.goal.rollback.apply", handleGoalRequest],
	["ai.next_step_hints", handleChatRequest],
	["session.reset", handleSessionRequest],
	["session.info", handleSessionRequest],
	["session.create", handleSessionRequest],
	["session.fork", handleSessionRequest],
	["session.worktree.create", handleSessionRequest],
	["session.worktree.operation.get", handleSessionRequest],
	["session.worktree.operation.cancel", handleSessionRequest],
	["session.worktree.setup.retry", handleSessionRequest],
	["session.worktree.setup.skip", handleSessionRequest],
	["session.worktree.handoff.preview", handleSessionRequest],
	["session.worktree.handoff.execute", handleSessionRequest],
	["session.worktree.delete", handleSessionRequest],
	["session.open", handleSessionRequest],
	["session.subscribe", handleSessionRequest],
	["session.unsubscribe", handleSessionRequest],
	["session.editor.bind", handleSessionRequest],
	["session.timeline", handleSessionRequest],
	["session.trace.summary", handleSessionRequest],
	["session.trace.page", handleSessionRequest],
	["session.trace.detail", handleSessionRequest],
	["session.timeline.search.index", handleSessionRequest],
	["session.timeline.search.start", handleSessionRequest],
	["session.timeline.search.page", handleSessionRequest],
	["session.timeline.search.cancel", handleSessionRequest],
	["session.selectionAsk.list", handleSelectionAskRequest],
	["session.selectionAsk.get", handleSelectionAskRequest],
	["session.selectionAsk.create", handleSelectionAskRequest],
	["session.selectionAsk.send", handleSelectionAskRequest],
	["session.selectionAsk.cancel", handleSelectionAskRequest],
	["session.selectionAsk.delete", handleSelectionAskRequest],
	["session.selectionAsk.deleteAll", handleSelectionAskRequest],
	["session.timeline.index", handleSessionRequest],
	["session.integrity.check", handleSessionRequest],
	["session.list", handleSessionRequest],
	["session.browser.snapshot", handleSessionRequest],
	["session.archive", handleSessionRequest],
	["session.archived.list", handleSessionRequest],
	["session.archived.restore", handleSessionRequest],
	["session.archived.delete", handleSessionRequest],
	["session.export", handleSessionRequest],
	["session.import", handleSessionRequest],
	["session.save", handleSessionRequest],
	["session.model.set", handleSessionRequest],
	["session.delete", handleSessionRequest],
	["session.rename", handleSessionRequest],
	["session.workspace.move", handleSessionRequest],
	["session.pin.set", handleSessionRequest],
	["session.compress", handleSessionRequest],
	["session.summary", handleSessionRequest],
	["session.overview.get", handleSessionRequest],
	["session.context.estimate", handleSessionRequest],
	["session.workflow.todo.dismiss", handleSessionRequest],
	["session.workbench.get", handleWorkbenchRequest],
	["session.workbench.patch", handleWorkbenchRequest],
	["session.guide.add", handleGuideRequest],
	["session.guide.update", handleGuideRequest],
	["session.guide.delete", handleGuideRequest],
	["session.guide.reorder", handleGuideRequest],
	["message.queue.list", handleMessageQueueRequest],
	["message.queue.add", handleMessageQueueRequest],
	["message.queue.update", handleMessageQueueRequest],
	["message.queue.remove", handleMessageQueueRequest],
	["message.queue.status", handleMessageQueueRequest],
	["message.queue.reorder", handleMessageQueueRequest],
	["mcp.listTools", handleMcpRequest],
	["mcp.callTool", handleMcpRequest],
	["mcp.listResources", handleMcpRequest],
	["mcp.readResource", handleMcpRequest],
	["mcp.config.list", handleMcpRequest],
	["mcp.config.add", handleMcpRequest],
	["mcp.config.update", handleMcpRequest],
	["mcp.config.remove", handleMcpRequest],
	["mcp.config.setEnabled", handleMcpRequest],
	["tool.catalog.list", handleToolRequest],
	["tool.execute", handleToolRequest],
	["fileChange.create", handleFileChangeRequest],
	["fileChange.overwrite", handleFileChangeRequest],
	["fileChange.delete", handleFileChangeRequest],
	["fileEdit.batch.get", handleFileEditRequest],
	["attachment.image.save", handleAttachmentRequest],
	["attachment.image.generated.get", handleAttachmentRequest],
	["attachment.image.get", handleAttachmentRequest],
	["attachment.text.save", handleAttachmentRequest],
	["attachment.text.get", handleAttachmentRequest],
	["plan.get", handlePlanRequest],
	["plan.clarify", handlePlanRequest],
	["plan.revise", handlePlanRequest],
	["plan.approve", handlePlanRequest],
	["approval.list", handleApprovalRequest],
	["approval.mode.set", handleApprovalRequest],
	["approval.approve", handleApprovalRequest],
	["approval.reject", handleApprovalRequest],
	["environment.configure", handleEnvironmentRequest],
	["environment.config.get", handleEnvironmentRequest],
	["environment.config.update", handleEnvironmentRequest],
	["environment.trust.update", handleEnvironmentRequest],
	["environment.actions.list", handleEnvironmentRequest],
	["editor.instances.list", handleEditorRequest],
	["editor.context.update", handleEditorRequest],
	["editor.heartbeat", handleEditorRequest],
	["editor.tool.result", handleEditorRequest],
	["workspace.list", handleWorkspaceRequest],
	["workspace.tree.order.get", handleWorkspaceRequest],
	["workspace.tree.order.update", handleWorkspaceRequest],
	["workspace.select", handleWorkspaceRequest],
	["workspace.update", handleWorkspaceRequest],
	["workspace.delete", handleWorkspaceRequest],
	["workspace.info", handleWorkspaceRequest],
	["workspace.worktree.eligibility.get", handleWorkspaceRequest],
	["workspace.worktree.status.list", handleWorkspaceRequest],
	["workspace.worktree.settings.get", handleWorkspaceRequest],
	["workspace.worktree.settings.update", handleWorkspaceRequest],
	["workspace.worktree.repair", handleWorkspaceRequest],
	["workspace.worktree.permanent.create", handleWorkspaceRequest],
	["workspace.worktree.permanent.delete", handleWorkspaceRequest],
	["workspace.git.diff.get", handleWorkspaceRequest],
	["workspace.git.diff.summary.get", handleWorkspaceRequest],
	["workspace.git.diff.file.get", handleWorkspaceRequest],
	["workspace.git.commit.message.generate", handleWorkspaceRequest],
	["workspace.git.commitOrPush", handleWorkspaceRequest],
	["workspace.git.branches.list", handleWorkspaceRequest],
	["workspace.git.branch.checkout", handleWorkspaceRequest],
	["workspace.git.branch.create", handleWorkspaceRequest]
]);

export function assertKnownRequestMethod(method: ClientRequest["method"]): void {
	if (!REQUEST_HANDLERS.has(method)) {
		throw new Error(`Request method is missing dispatcher registration: ${method}`);
	}
}

export async function dispatchRequest(
	socket: WebSocket,
	request: ClientRequest,
	session: ClientSession,
	mcpHost: McpHost
): Promise<void> {
	const handler: RequestHandler | undefined = REQUEST_HANDLERS.get(request.method);
	if (handler === undefined) {
		throw new Error(`Request method is missing dispatcher registration: ${request.method}`);
	}

	await handler(socket, request, session, mcpHost);
}
