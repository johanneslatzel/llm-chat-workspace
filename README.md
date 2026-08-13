# LLM Chat Workspace

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![NPM](https://nodei.co/npm/@johannes.latzel/llm-chat-workspace.svg?style=shields&data=n,v,u,d,s)](https://www.npmjs.com/package/@johannes.latzel/llm-chat-workspace)
[![version](https://img.shields.io/github/package-json/v/johanneslatzel/llm-chat-workspace)](https://github.com/johanneslatzel/llm-chat-workspace/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/johanneslatzel/llm-chat-workspace/pulls)
[![Feedback Welcome](https://img.shields.io/badge/feedback-welcome-brightgreen)](https://github.com/johanneslatzel/llm-chat-workspace/discussions)
[![codecov](https://codecov.io/gh/johanneslatzel/llm-chat-workspace/graph/badge.svg)](https://codecov.io/gh/johanneslatzel/llm-chat-workspace)
[![CI](https://github.com/johanneslatzel/llm-chat-workspace/actions/workflows/ci.yml/badge.svg)](https://github.com/johanneslatzel/llm-chat-workspace/actions/workflows/ci.yml)
[![Socket Badge](https://badge.socket.dev/npm/package/@johannes.latzel/llm-chat-workspace/latest)](https://badge.socket.dev/npm/package/@johannes.latzel/llm-chat-workspace/latest)
[![AI Assisted Yes](https://img.shields.io/badge/AI%20Assisted-Yes-green)](https://github.com/mefengl/made-by-ai)

Workspace and path-access management for the [`llm-chat`](https://github.com/johanneslatzel/llm-chat) package. Provides the shared workspace management layer used by [`llm-chat-file`](https://github.com/johanneslatzel/llm-chat-file) and [`llm-chat-shell`](https://github.com/johanneslatzel/llm-chat-shell).

## Features

- `DirectoryConfiguration`: defines which directories are accessible (read and/or write), at what permission level, and how duplicate accesses for the same path are resolved (write-wins by default, or last-added-wins)
- `Workspace`: tracks the active workspace path and enforces read/write access control for all file operations; mutex-guarded, thread-safe `switchWorkspace()` with an optional `onSwitch` hook; optional symlink resolution to block path traversal
- `SwitchWorkspaceTool`: `llm-chat` tool that changes the active workspace directory within configured accessible directories
- `walk()`: recursive directory traversal that skips configured directories (e.g. `node_modules`, `.git`)

## Prerequisites

- Node.js >= 18

## Installation

```bash
npm install @johannes.latzel/llm-chat-workspace
```

## Documentation

Full documentation at **[johanneslatzel.github.io/llm-chat-workspace/](https://johanneslatzel.github.io/llm-chat-workspace/)**

## License

MIT - see [`LICENSE`](LICENSE).

## Contributing

Issues and PRs welcome at [github.com/johanneslatzel/llm-chat-workspace](https://github.com/johanneslatzel/llm-chat-workspace).
