# API Reference

## DirectoryConfiguration

Configures which directories are accessible and at what permission level. Construct with no arguments to read all values from environment variables, or pass specific arguments to override them.

```typescript
import { AccessType, DirectoryConfiguration } from '@johannes.latzel/llm-chat-workspace';

const config = new DirectoryConfiguration([
    { type: AccessType.Read, path: '/var/log' },
    { type: AccessType.Write, path: '/home/project' },
]);
```

| Property | Type | Description |
|----------|------|-------------|
| `accesses` | `{ type: AccessType; path: string }[]` | List of access entries |
| `skipDirs` | `string[]` | Directory names to skip when walking |
| `resolveSymlinks` | `boolean` | Resolve symlinks before access checks |
| `workspacePath` | `string` | The default workspace path |

- `deduplicate()`: returns a new configuration with overlapping accesses merged (write access wins)

## Workspace

Manages the active workspace path and enforces access control for all file operations.

```typescript
import { DirectoryConfiguration, Workspace } from '@johannes.latzel/llm-chat-workspace';

const workspace = new Workspace(new DirectoryConfiguration([
    { type: AccessType.Write, path: '/home/project' },
]));
```

| Member | Description |
|--------|-------------|
| `currentPath` | The active workspace directory (absolute) |
| `switchWorkspace(target)` | Changes the active path (mutex-guarded); throws if outside configured directories |
| `normalize(input)` | Resolves a relative or absolute path against the active workspace |
| `canRead(absPath)` | `true` if the path is within a read or write directory |
| `canWrite(absPath)` | `true` if the path is within a write directory |
| `getAccesses()` | The configured access entries |
| `addAccess(type, dir)` | Adds a directory access entry (write wins over read, duplicates collapsed) |
| `removeAccess(dir)` | Removes all access entries for the directory; throws if none would remain |
| `setSkipDirs(dirs)` | Replaces the list of directory names skipped when walking |
| `setResolveSymlinks(value)` | Enables or disables symlink resolution before access checks |
| `setWorkspacePath(target?)` | Sets the default workspace path; `undefined` clears it |
| `get workspacePath` | The configured default workspace path, or `undefined` when unset |
| `getConfiguration()` | Returns a snapshot of the configuration as a new `DirectoryConfiguration` |
| `skipDirs` | Directory names skipped when walking |
| `resolveSymlinks` | Whether symlink resolution is enabled |
| `pathHint(raw, resolved)` | Diagnostic hint for failed access checks |
| `walk(dir, onError?)` | Async generator yielding `WalkEntry` for files and directories |

## SwitchWorkspaceTool (tool name: `switch_workspace`)

Changes the current workspace path to a new directory within configured accessible directories. Must be called before any other filesystem tool when changing workspace. Do NOT call this tool in parallel with any other filesystem tool. Call it first, then call the other tools sequentially.

```typescript
import { DirectoryConfiguration, Workspace, SwitchWorkspaceTool } from '@johannes.latzel/llm-chat-workspace';

const workspace = new Workspace(new DirectoryConfiguration([
    { type: AccessType.Write, path: '/home/project' },
]));
const tool = new SwitchWorkspaceTool(workspace);
```

**Parameters:**

| Parameter | Type   | Required | Description                |
| --------- | ------ | -------- | -------------------------- |
| `path`    | string | yes      | Target directory path.     |

**Returns:** `"Switched workspace to: <path>"` on success, or an error message on failure.
