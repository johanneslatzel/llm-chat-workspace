# Architecture

## Overview

`llm-chat-workspace` is a standalone, independently publishable package that provides workspace and path-access management for the `llm-chat` ecosystem. It is used by [`llm-chat-file`](https://github.com/johanneslatzel/llm-chat-file) and [`llm-chat-shell`](https://github.com/johanneslatzel/llm-chat-shell).

## Design

### Access model

`DirectoryConfiguration` defines which directories are accessible and at what permission level. Each access entry pairs an `AccessType` (`read` or `write`) with an absolute directory path. The configuration can be built from constructor arguments or read from `LLM_CHAT_WORKSPACE_*` environment variables, and is deduplicated with write access taking precedence over read access.

### Workspace

The `Workspace` class is the central gatekeeper for all path operations:

```typescript
const ws = new Workspace(new DirectoryConfiguration([
    { type: AccessType.Read, path: '/var/log' },
    { type: AccessType.Write, path: '/home/project' },
]));
```

**Key methods:**

- `normalize(input)` — resolves relative paths against `currentPath`; absolute paths are returned as-is
- `canRead(absPath)` — checks if a resolved path falls within any read or write access directory
- `canWrite(absPath)` — checks if a resolved path falls within a write access directory
- `getAccesses()` — returns all configured directory accesses with their types and resolved paths
- `walk(dir)` — async generator that recursively walks directories, skipping names listed in `skipDirs`

### Path security

All operations follow the same access control pattern:

1. The raw user-supplied path is normalized via `ws.normalize(path)`
2. The caller checks `ws.canRead()` or `ws.canWrite()` on the resolved path
3. Path traversal attempts (e.g. `../../etc/passwd`) are blocked because `path.resolve()` resolves `..` segments before the access check

By default, symlinks are followed as-is: if a configured directory contains a symlink pointing outside, the symlink target is accessible. Set `LLM_CHAT_WORKSPACE_RESOLVE_SYMLINKS=true` (or pass `resolveSymlinks: true` to `DirectoryConfiguration`) to resolve symlinks via `fs.realpathSync.native()` before access checks. This prevents symlink-based path traversal but may break legitimate symlinks.

**Access rules:**

| Operation | Check |
|-----------|-------|
| `switch_workspace` | within any configured directory |

### Concurrency

`switchWorkspace()` uses `async-mutex` to prevent concurrent switches from interleaving. After a successful switch, the optional `onSwitch` hook is awaited before the tool result is returned — this is how `llm-chat-shell` keeps its active bash session in sync with the workspace directory. The hook is not fired when the path is set in the constructor, and not fired when the switch throws.

### Tool classes

`SwitchWorkspaceTool` extends `Tool` from `llm-chat`:

1. The constructor accepts a `Workspace` instance and calls `super(name, description, params)`
2. `onExecute()` validates parameters, calls `switchWorkspace()`, and returns `PartialToolResult`
3. All errors are caught and returned as plain-string messages — tools never throw

## Dependencies

- `llm-chat` — framework providing `Tool`, `ToolParameters`, etc. (peer dependency)
- `async-mutex` — mutex used for thread-safe workspace switching
