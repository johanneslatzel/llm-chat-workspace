# Quick Start

## Installation

```bash
npm install @johannes.latzel/llm-chat-workspace
```

## Quick setup

```typescript
import {
    AccessType,
    DirectoryConfiguration,
    Workspace,
    SwitchWorkspaceTool,
} from '@johannes.latzel/llm-chat-workspace';

const config = new DirectoryConfiguration([
    { type: AccessType.Read, path: '/var/log' },
    { type: AccessType.Write, path: '/home/project' },
]);

const workspace = new Workspace(config);
await workspace.switchWorkspace('/home/project/src');

const switchTool = new SwitchWorkspaceTool(workspace);
```

## Next steps

See the [API Reference](api-reference.md) for tool and class documentation and [Architecture](architecture.md) for design details.
