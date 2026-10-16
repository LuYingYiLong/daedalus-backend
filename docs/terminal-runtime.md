# Terminal verification environment

`run_command` accepts an opaque shell command line. On Windows the sandbox helper starts `cmd.exe` first, then passes the command line to it. Presets use the separate executable-plus-arguments path. Neither mode interprets the entire shell command as an executable name.

Normal sandbox runs use a workspace-local `.daedalus-terminal` directory for Home, cache, application data and temporary files. The directory is created after the command is authorized; an existing symlink or a path escaping the workspace is rejected. Full Trust keeps the host environment. The workspace directory may contain tool caches and should be excluded from version control if a project tracks all files.

Before a command, `get_terminal_capabilities` can check executable names and environment-variable names without running them:

```json
{
  "commands": ["gradlew.bat", "node", "python"],
  "environmentVariables": ["JAVA_HOME", "VIRTUAL_ENV"]
}
```

For commands, `sandbox_ready` means the executable is in the workspace or a platform system directory. `external_access_required` means it exists on the host but needs an `externalAccess` target on the actual command. `not_found` means it was not found. For variables, `explicit_value_required` means the host has a value that is deliberately not copied into the sandbox. The check returns names and paths, never variable values.

For a runtime installed outside the workspace, supply a narrow `externalAccess` target with `mode: "execute"` and a reason. The reviewed target is mounted read-only and its executable directory is prepended to the restricted PATH for that invocation. Supply any required runtime variables through `env`. A `mode: "read"` target remains readable but is not added to PATH. Network access and execution without the OS sandbox continue to use their existing separate approval boundaries. There is no automatic fallback to Full Trust.

An unavailable executable or sandbox launch failure returns `terminal_runtime_unavailable` with `environmentIssue: true` and `validationStatus: "not_applicable"`. Source or test failures remain ordinary failed validation. Repeating the same command without fixing its runtime configuration will not change this result.
