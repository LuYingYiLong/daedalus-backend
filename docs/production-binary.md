# Production Backend Binary

Daedalus Studio production builds use a Windows x64 Node.js SEA binary plus a separately verified Windows AppContainer sandbox helper. The SEA binary contains the CommonJS application bundle, runtime text assets, Godot helper script, and the pinned `keytar.node` addon. End users do not need Node.js, npm, Visual Studio, or `node-gyp`.

## CLI

```text
daedalus-backend.exe serve
daedalus-backend.exe version --json
daedalus-backend.exe self-test --json
daedalus-backend.exe mcp terminal|workspace|godot|documentation|skills|external
daedalus-backend.exe connection-token --connection-id <id> --json
```

Automation MCP remains source-development only.

## Release Assets

A backend tag publishes:

- `daedalus-backend-win32-x64.zip`
- `daedalus-backend-win32-x64.json`
- `daedalus-backend-win32-x64.cdx.json`
- `daedalus-backend-linux-x64.zip`
- `daedalus-backend-linux-x64.json`
- `daedalus-backend-linux-x64.cdx.json`
- `daedalus-backend_<version>_amd64.deb`
- platform-specific SHA-256 checksum files

The Windows ZIP contains `daedalus-backend.exe`, the signed-by-manifest `daedalus-windows-sandbox-helper.exe`, `backend-manifest.json`, and the bundled image processing runtime. Studio pins a concrete backend version, validates both binaries and their hashes, runs `self-test`, then activates the candidate through a recoverable pending-update transaction. Studio injects the helper path into the Backend process automatically; it never falls back to an unsandboxed process.

The Linux deb installs the SEA executable, `backend-manifest.json`, and the bundled image processing runtime under `/usr/lib/daedalus-backend`, with a launcher at `/usr/bin/daedalus-backend`. The Linux ZIP contains the same runtime for clients that manage Backend installation themselves.

## Runtime Authentication

Studio starts the backend on `127.0.0.1` with a random 256-bit token and connection ID. The token is accepted as either a Bearer credential or the `daedalus-auth.<token>` WebSocket subprotocol.

`%USERPROFILE%\.daedalus\backend\connection.json` is an atomic, non-secret discovery record. It contains the connection ID, port, PID, executable path, version, build ID, and protocol version. The token itself is stored in Windows Credential Manager.

A same-user Godot integration can read the discovery record and invoke the listed executable with `connection-token`. The command succeeds only when the connection ID, active backend PID, and current executable path match. Do not log or persist the returned `authProtocol`.

## Release Gate

`npm run build:sea:win` requires Windows x64 and Node.js 24.18.0 or newer within Node 24. It builds the SEA, rejects development runtime lookups, and performs black-box checks for:

- embedded assets, SQLite, and Credential Manager;
- authenticated health and unauthenticated rejection;
- runtime connection discovery without a plaintext token;
- terminal, workspace, Godot, skills, and external MCP startup;
- graceful shutdown.

The first release phase is explicitly unsigned. Enabling Authenticode later must sign before archive hashing and set the manifest status to `signed`.
