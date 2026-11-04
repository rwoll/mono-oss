// Test helpers for backends and for code that uses them: an in-memory `FakeBackend`, and the backend
// conformance suite that every backend passes. Nothing here loads a test runner.
export { backendConformance, CONFORMANCE_COMMANDS, emulateCommand } from './conformance.ts'
export type { ConformanceCase, ConformanceContext, ConformanceTarget, ConformanceWorld, EmulatedFile, EmulateOptions } from './conformance.ts'
export { ALL_CAPABILITIES } from './contract.ts'
export { FakeBackend } from './fake.ts'
export type { FakeBackendOptions, FakeExec, FakeExecResult, FakeFile, FakeMachine, FakeSnapshot } from './fake.ts'
