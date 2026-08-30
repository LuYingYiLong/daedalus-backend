import * as fs from "node:fs/promises";
import * as path from "node:path";
import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { getSessionWorkspaceRoot } from "../session-preview.js";

export async function handleFileChangeRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, _mcpHost: McpHost): Promise<void> {
	switch (request.method) {
	case "fileChange.create": {
		const projectPath: string = getSessionWorkspaceRoot(session);

		if (!projectPath) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "config_error",
					message: "No workspace selected and GODOT_PROJECT_PATH is not configured"
				}
			});
			break;
		}

		const cleanedPath: string = request.params.relativePath.trim().replaceAll("\\", "/");
		const resolvedPath: string = path.resolve(projectPath, cleanedPath);

		// Validate path safety
		let pathError: string | null = null;
		const relative: string = path.relative(projectPath, resolvedPath).replaceAll(path.sep, "/");

		if (!resolvedPath.startsWith(path.resolve(projectPath))) {
			pathError = "Path traversal denied";
		} else {
			const segments: string[] = relative.split("/");

			for (const segment of segments) {
				if (segment.startsWith(".")) {
					pathError = `Hidden directory not allowed: ${segment}`;
					break;
				}
			}
		}

		if (!pathError && (relative.startsWith(".godot/") || relative === ".godot" || relative.startsWith("addons/") || relative === "addons")) {
			pathError = `Writing to ${relative.split("/")[0]}/ is not allowed`;
		}

		const allowedExtensions: Set<string> = new Set([".gd", ".tres", ".tscn", ".json", ".md", ".txt"]);
		const ext: string = path.extname(resolvedPath);

		if (!pathError && !allowedExtensions.has(ext)) {
			pathError = `Extension not allowed: ${ext}. Allowed: ${Array.from(allowedExtensions).join(", ")}`;
		}

		// TSCN structure validation for .tscn files
		if (!pathError && ext === ".tscn" && request.params.content.length > 0) {
			const trimmedContent: string = request.params.content.trimStart();
			if (!/^\[gd_scene\s/.test(trimmedContent)) {
				pathError = "TSCN file must start with [gd_scene ...] header";
			} else if (!/^\[node\s/m.test(trimmedContent)) {
				pathError = "TSCN file must contain at least one [node ...] section (root node)";
			}
		}

		if (pathError) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "invalid_path", message: pathError }
			});
			break;
		}

		try {
			await fs.access(resolvedPath);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "file_exists", message: `File already exists: ${relative}` }
			});
			break;
		} catch {
			// File does not exist — proceed
		}

		try {
			await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
			await fs.writeFile(resolvedPath, request.params.content, "utf8");
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { created: true, path: relative }
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "write_error",
					message: error instanceof Error ? error.message : "Failed to write file"
				}
			});
		}
		break;
	}

	case "fileChange.overwrite": {
		const projectPath: string = getSessionWorkspaceRoot(session);

		if (!projectPath) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "config_error", message: "No workspace selected" }
			});
			break;
		}

		const cleanedPath: string = request.params.relativePath.trim().replaceAll("\\", "/");
		const resolvedPath: string = path.resolve(projectPath, cleanedPath);

		if (!resolvedPath.startsWith(path.resolve(projectPath))) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "invalid_path", message: "Path traversal denied" }
			});
			break;
		}

		const relative: string = path.relative(projectPath, resolvedPath).replaceAll(path.sep, "/");

		if (relative.startsWith(".godot/") || relative === ".godot") {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "invalid_path", message: "Cannot overwrite files in .godot/" }
			});
			break;
		}

		const allowedExtensions: Set<string> = new Set([".gd", ".tres", ".tscn", ".json", ".md", ".txt"]);
		const ext: string = path.extname(resolvedPath);

		if (!allowedExtensions.has(ext)) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "invalid_extension", message: `Extension not allowed: ${ext}` }
			});
			break;
		}

		// TSCN structure validation for .tscn files
		if (ext === ".tscn" && request.params.content.length > 0) {
			const trimmedContent: string = request.params.content.trimStart();
			if (!/^\[gd_scene\s/.test(trimmedContent)) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "invalid_content", message: "TSCN file must start with [gd_scene ...] header" }
				});
				break;
			} else if (!/^\[node\s/m.test(trimmedContent)) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "invalid_content", message: "TSCN file must contain at least one [node ...] section (root node)" }
				});
				break;
			}
		}

		try {
			await fs.access(resolvedPath);
		} catch {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "file_not_found", message: `File does not exist: ${relative}` }
			});
			break;
		}

		try {
			await fs.writeFile(resolvedPath, request.params.content, "utf8");
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { overwritten: true, path: relative }
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "write_error",
					message: error instanceof Error ? error.message : "Failed to overwrite file"
				}
			});
		}
		break;
	}

	case "fileChange.delete": {
		const projectPath: string = getSessionWorkspaceRoot(session);

		if (!projectPath) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "config_error", message: "No workspace selected" }
			});
			break;
		}

		const cleanedPath: string = request.params.relativePath.trim().replaceAll("\\", "/");
		const resolvedPath: string = path.resolve(projectPath, cleanedPath);

		if (!resolvedPath.startsWith(path.resolve(projectPath))) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "invalid_path", message: "Path traversal denied" }
			});
			break;
		}

		const relative: string = path.relative(projectPath, resolvedPath).replaceAll(path.sep, "/");

		if (relative.startsWith(".godot/") || relative === ".godot") {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "invalid_path", message: "Cannot delete files in .godot/" }
			});
			break;
		}

		try {
			const stat = await fs.stat(resolvedPath);
			if (!stat.isFile()) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "not_a_file", message: `Not a file: ${relative}` }
				});
				break;
			}
		} catch {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "file_not_found", message: `File does not exist: ${relative}` }
			});
			break;
		}

		try {
			await fs.unlink(resolvedPath);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { deleted: true, path: relative }
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "delete_error",
					message: error instanceof Error ? error.message : "Failed to delete file"
				}
			});
		}
		break;
	}

		default:
			throw new Error(`Unsupported file-change method: ${request.method}`);
	}
}
