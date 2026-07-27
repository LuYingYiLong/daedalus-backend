# Daedalus Backend

Daedalus Backend is the TypeScript runtime service for the Godot Daedalus editor plugin. It provides the WebSocket/RPC backend, multi-provider chat integration, approval-gated Godot project tools, session persistence, MCP host support, and Godot MCP servers.

This npm package is a source-runtime package. It publishes the TypeScript source and small JavaScript bin launchers, then runs the source through `tsx` at runtime. It does not publish compiled `dist/` output.

Daedalus Studio production builds use the separately versioned Windows x64 single-executable distribution. Its CLI, release assets, runtime authentication, and update transaction are documented in [docs/production-binary.md](docs/production-binary.md).

For the long-term split between the lightweight Godot editor plugin and the standalone Daedalus Studio workbench, see [docs/frontend-boundary-and-studio-roadmap.md](docs/frontend-boundary-and-studio-roadmap.md).

## Requirements

- Node.js 24.18.0 or newer.
- npm.
- Godot 4.7 for the public Beta validation path. Godot 4.x may work, but Windows + Godot 4.7 is the first supported Beta target.

## Install

Global install:

```powershell
npm install -g daedalus-backend
```

Local project install:

```powershell
npm install daedalus-backend
```

## Run The WebSocket Backend

After installing the package, start it through the published bin command:

```powershell
$env:PORT = "38180"
godot-daedalus-backend
```

The Godot plugin connects to this backend over WebSocket. Provider configuration, including API keys, is normally saved from the plugin settings UI.

## Providers

The built-in catalog includes DeepSeek, Moonshot, OpenAI, and Zhipu AI. Zhipu AI uses the standard PaaS OpenAI-compatible base URL `https://open.bigmodel.cn/api/paas/v4`; its default text model is `glm-5.2`. Set an image-capable model such as `glm-5v-turbo` for the Image Recognition task when sending screenshots or other image attachments.

API keys are stored in keytar only. They are never written to `%USERPROFILE%\.daedalus` configuration files. A custom base URL remains available for a compatible proxy or specialized provider endpoint.

If the package is installed locally in another project, use npm exec or the local `.bin` command:

```powershell
npm exec godot-daedalus-backend
.\node_modules\.bin\godot-daedalus-backend.cmd
```

Do not use `npm run dev` from the consuming Godot project unless that project's own `package.json` defines a `dev` script. `npm run dev` is only a source-repository development command.

To add a convenient script in the consuming project:

```json
{
  "scripts": {
    "daedalus": "godot-daedalus-backend"
  }
}
```

Then run:

```powershell
npm run daedalus
```

## Daedalus Manager

The package also ships `godot-daedalus-manager`, a JSON-first manager CLI used by the Godot plugin for stable install, update, launch, rollback, and diagnostics workflows.

```powershell
godot-daedalus-manager --json status --project "D:\GodotProjects\example"
godot-daedalus-manager --json backend install
godot-daedalus-manager --json backend start --port 38180
godot-daedalus-manager --json backend stop
godot-daedalus-manager --json backend rollback
```

Backend installs are versioned under `%USERPROFILE%\.daedalus\backend\versions\<version>`. The manager switches `%USERPROFILE%\.daedalus\backend\current.json` after a new version is staged, avoiding in-place edits of a running `node_modules` directory.

Frontend plugin updates are staged rather than hot-applied. GitHub releases should provide:

```text
godot-daedalus-plugin-vX.Y.Z.zip
godot-daedalus-plugin-vX.Y.Z.manifest.json
```

The zip must contain `addons/godot_daedalus/plugin.cfg`. The manifest must include `version`, `tag`, `sha256`, `assetName`, and `minGodotVersion`.

Manager logs and runtime state live under `%USERPROFILE%\.daedalus`. If a frontend update is blocked by a Godot file lock, close Godot and run the pending update again. Rollback commands are available for both backend and frontend:

```powershell
godot-daedalus-manager --json backend rollback
godot-daedalus-manager --json frontend rollback --project "D:\GodotProjects\example"
```

## Run The Godot MCP Server

The standalone Godot MCP server requires a Godot project path:

```powershell
$env:GODOT_PROJECT_PATH = "D:\GodotProjects\example"
godot-daedalus-mcp
```

## Run The Terminal MCP Server

The terminal MCP server exposes guarded verification commands, including Godot headless checks. Configure the project and Godot executable first:

```powershell
$env:GODOT_PROJECT_PATH = "D:\GodotProjects\example"
$env:GODOT_EXECUTABLE_PATH = "D:\Godot_v4.7-stable_win64.exe\Godot_v4.7-stable_win64.exe"
godot-daedalus-terminal-mcp
```

## Run The Automation MCP Server

Automation MCP is a development-only MCP server for external smoke clients such as Codex. It controls the backend through normal WebSocket/RPC calls and is not exposed to the Godot plugin MCP menu or to Daedalus in-product LLM tools.

It is disabled unless explicitly enabled:

```powershell
$env:DAEDALUS_AUTOMATION_MCP = "1"
npm run automation:mcp -- --backend-url ws://localhost:38180
```

Published package users can run:

```powershell
$env:DAEDALUS_AUTOMATION_MCP = "1"
godot-daedalus-automation-mcp --backend-url ws://localhost:38180
```

See [`docs/automation-mcp.md`](docs/automation-mcp.md) for Codex MCP configuration, approval whitelist settings, tool names, and smoke workflow examples.

## Skills

Daedalus discovers skills from three sources:

- Project: `<project>/.github/skills/<slug>/SKILL.md`
- Personal: `%USERPROFILE%/.daedalus/skills/<slug>/SKILL.md`
- Built-in: trusted skills shipped with the backend

Every `SKILL.md` starts with strict frontmatter containing non-empty `name` and `description` fields, followed by a non-empty instruction body. Project and built-in skills are enabled by default per workspace; personal skills are opt-in for each workspace.

Type `@` in the Godot chat input to attach one or more enabled skills to the current message. The model may also load an enabled skill when its catalog description clearly matches the task. Skill content never grants tools or bypasses tool approval.

Use `/create-skill <requirements>` to ask AI to create a project skill, or `/create-skill --personal <requirements>` for a personal skill. Creation is restricted to the managed skill roots, refuses existing directories, and requires normal write-tool approval.

## Development

```powershell
npm install
npm run typecheck
npm test
npm run pack:check
```

Useful scripts:

- `npm start`: run the WebSocket backend from source.
- `npm run mcp`: run the Godot MCP server from source.
- `npm run terminal:mcp`: run the terminal MCP server from source.
- `npm run automation:mcp`: run the development-only Automation MCP server. Requires `DAEDALUS_AUTOMATION_MCP=1`.
- `npm run ping`: run the local ping client.
- `npm run pack:check`: inspect the npm package contents without publishing.
- `npm run smoke:beta`: start the backend and run the Windows/Godot public Beta smoke checks.
- `npm run smoke:automation`: run the Automation WebSocket/RPC smoke matrix; add `use_llm scenario=plan_clarify` for a real provider Plan smoke.
- `npm run smoke:llm -- use_llm model_id=deepseek-v4-pro`: start a temporary backend, run one real provider Agent write against a timestamped smoke file, auto-approve only that smoke write, and verify the persisted inline diff batch.
- `npm run dev:llm -- model_id=deepseek-v4-pro`: development shortcut for the same real LLM inline diff smoke.

Public Beta release readiness is tracked in [`docs/beta-release-checklist.md`](docs/beta-release-checklist.md). The checklist covers Windows CI, Godot headless checks, real provider manual validation, frontend package rules, rollback, and security regression checks.

## Published Files

The npm package uses the `files` whitelist in `package.json`. Runtime users receive:

- `bin/`
- `docs/`
- `src/`
- `scripts/beta-smoke.ps1`
- `scripts/llm-inline-diff-smoke.ts`
- `README.md`
- `package.json`

Tests, local agent instructions, generated tarballs, environment files, and `node_modules/` are not published.

Before publishing:

```powershell
npm test
npm run check
npm run smoke:beta
# Optional paid/network validation before a public Beta:
npm run smoke:llm -- use_llm provider=deepseek model_id=deepseek-v4-pro
npm publish --dry-run
npm publish
```
