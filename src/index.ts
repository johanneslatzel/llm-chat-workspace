export { DirectoryConfiguration } from './lib/config.js';
export { EphemeralWorkspaceProvisioner } from './lib/ephemeral.js';
export type { EphemeralWorkspace, EphemeralWorkspaceConfiguration } from './lib/ephemeral.js';
export {
    WorkspaceBusyError,
    WorkspaceCapacityError,
    WorkspaceNotFoundError,
    WorkspaceStore
} from './lib/store.js';
export type {
    WorkspaceInfo,
    WorkspaceLease,
    WorkspaceSession,
    WorkspaceSessionFactory,
    WorkspaceStoreConfiguration,
    WorkspaceUsage
} from './lib/store.js';
export { AccessPrecedence, AccessType } from './lib/types.js';
export type { Access, WalkEntry } from './lib/types.js';
export { Workspace } from './lib/workspace.js';
export { SwitchWorkspaceTool } from './tools/switch-workspace.js';
