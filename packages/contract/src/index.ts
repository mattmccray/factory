// Public API of the factory/v1 contract (docs/contract/v1.md).
export type { Config, EventInput, FactoryEvent, Role, Stage, Verdict } from './contract';
export { checkTransition, parseConfig, parseEventInput } from './contract';
export type { AgentSpan, Decision, JobSnapshot, ReviewState, StageSpan } from './project';
export { project } from './project';
export { appendEvent, readLog, readVerdict, rebuild } from './store';
export { parseFields } from './fields';
export { formatShow } from './show';
