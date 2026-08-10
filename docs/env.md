# Environment Variables

Set these however you prefer (shell, `.env`, etc.). A `.env.example` is included. All variables are optional — constructor parameters take precedence over environment variables.

## Access control

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_CHAT_WORKSPACE_READ_DIRS` | — | Comma-separated directories with read-only access |
| `LLM_CHAT_WORKSPACE_WRITE_DIRS` | — | Comma-separated directories with read-write access |
| `LLM_CHAT_WORKSPACE_PATH` | `process.cwd()` | Default workspace directory (auto-added as writable) |
| `LLM_CHAT_WORKSPACE_SKIP_DIRS` | — | Comma-separated directory names to skip when walking trees (e.g. `node_modules`, `.git`) |
| `LLM_CHAT_WORKSPACE_RESOLVE_SYMLINKS` | `false` | Set to `"true"` to resolve symlinks before access checks |
