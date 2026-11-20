export { default as CopyBlock } from './components/CopyBlock.vue'
export { LazyPageAccessDialog } from './components/lazy'
export { default as PageAccessDialog } from './components/PageAccessDialog.vue'
export { default as RequestAccessCard } from './components/RequestAccessCard.vue'
export {
  captureKitInstallCommand,
  KEY_ENV,
  mcpClients,
  SKILL_NAME,
  skillDirGuides,
  skillInstallCommand,
  skillStackInstallCommand,
  type McpClientGuide,
} from './model/mcp-clients'
export { clientMark } from './model/client-logos'
export {
  CONNECT_ROLES,
  CONNECT_WORKFLOWS,
  hasPreferences,
  scopeFor,
  stepsFor,
  toolsetsFor,
  workflowsFor,
  type ConnectRole,
  type ConnectStep,
  type ConnectWorkflow,
} from './model/connect-plan'
export { warnMentionedWithoutAccess } from './model/mention-access'
