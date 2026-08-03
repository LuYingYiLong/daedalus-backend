import { createInterface } from "node:readline";
import { buildGodotDocumentationIndex } from "./indexer.js";
import { checkDocumentationGeneration } from "./health.js";

type DocumentationIndexerCommand =
	| {
		id: string;
		type: "build";
		extractedRoot: string;
		indexPath: string;
		branch: string;
		commitSha: string;
	}
	| {
		id: string;
		type: "check";
		generationDir: string;
		branch: string;
		commitSha: string;
	};

function write(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function runDocumentationIndexerProcess(): Promise<void> {
	const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of input) {
		let command: DocumentationIndexerCommand;
		try {
			command = JSON.parse(line) as DocumentationIndexerCommand;
		} catch {
			continue;
		}
		try {
			if (command.type === "build") {
				const summary = await buildGodotDocumentationIndex({
					extractedRoot: command.extractedRoot,
					indexPath: command.indexPath,
					branch: command.branch,
					commitSha: command.commitSha,
					onProgress(progress: number): void {
						write({ id: command.id, type: "progress", progress });
					}
				});
				write({ id: command.id, type: "completed", summary });
			} else {
				const manifest = await checkDocumentationGeneration({
					generationDir: command.generationDir,
					record: { branch: command.branch, commitSha: command.commitSha },
					deep: true
				});
				write({ id: command.id, type: "completed", manifest });
			}
		} catch (error: unknown) {
			write({
				id: command.id,
				type: "error",
				code: error !== null && typeof error === "object" && "code" in error ? String(error.code) : null,
				message: error instanceof Error ? error.message : String(error)
			});
		}
		break;
	}
	input.close();
}
