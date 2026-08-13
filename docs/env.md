# Environment Variables

Set these via the shell, a `.env` file, or any other mechanism. A `.env.example` is included. All variables are optional. Constructor parameters take precedence over environment variables.

## Access control

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_CHAT_WORKSPACE_READ_DIRS` | none | Comma-separated directories with read-only access |
| `LLM_CHAT_WORKSPACE_WRITE_DIRS` | none | Comma-separated directories with read-write access |
| `LLM_CHAT_WORKSPACE_PATH` | `process.cwd()` | Default workspace directory (auto-added as writable) |
| `LLM_CHAT_WORKSPACE_SKIP_DIRS` | none | Comma-separated directory names to skip when walking trees (e.g. `node_modules`, `.git`) |
| `LLM_CHAT_WORKSPACE_RESOLVE_SYMLINKS` | `false` | Set to `"true"` to resolve symlinks before access checks |
| `LLM_CHAT_WORKSPACE_PRECEDENCE` | `write-wins` | How duplicate accesses for the same path are resolved: `write-wins` (write beats read) or `last-added-wins` (the last supplied access wins). Invalid values fall back to `write-wins` |
