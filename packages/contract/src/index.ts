// Public API of the factory/v1 contract (docs/contract/v1.md).
export type { Config, EventInput, FactoryEvent, MergePolicy, Role, RoleRunner, Runner, Stage, Verdict } from './contract';
export { CURRENT_TARGET, DEFAULT_MODEL, MODEL_PATTERN, checkTransition, mergeTarget, parseConfig, parseEventInput } from './contract';
export type { AgentSpan, Decision, JobSnapshot, ReviewState, StageSpan } from './project';
export { project } from './project';
export { appendEvent, readLog, readVerdict, rebuild } from './store';
export { parseFields } from './fields';
export { formatShow } from './show';
export type { Manifest } from './manifest';
export { checkManifestPath, parseManifest } from './manifest';
export type { Registry, RegistryProject } from './registry';
export { addRoot, checkRoot, parseRegistry, readRegistry, registryPath, registryText, removeRoot } from './registry';
