// The Blobby Sandbox SDK. Clients use `connect`, in-process or with a `blobby-sandbox serve` URL; the CLI
// and the canvas are thin wrappers around it. Servers and embedders use the engine, `Sandboxes`, its tRPC
// router, and `serve`. Backends live at their own subpaths, such as `@rwoll/blobby-sandbox/smolvm`, and
// load only when chosen; `@rwoll/blobby-sandbox/testing` has a fake backend and the conformance suite.
// `@rwoll/blobby-sandbox/callbacks` has the callback protocol and resolvers, and
// `@rwoll/blobby-sandbox/tools` plain agent tools for a sandbox's desktop.

// Client
export { connect, createEngine, Sandbox, SandboxClient, SandboxDesktop, SandboxFiles } from './client.ts'
export type { ClientExecOptions, ClientStartOptions, ConnectOptions, FileData, FileTransfer, RecordedVideo, Recording, Viewer, WriteFileOptions } from './client.ts'
export { normalizeSecret, PLAIN_FIELDS, redact, Secrets, totp } from './secrets.ts'
export type { SecretStatus, SecretValues } from './secrets.ts'
export { binding, seal } from './callbacks/seal.ts'
export type { Sealed } from './callbacks/seal.ts'
export { LocalResolver } from './callbacks/local.ts'
export type { AuditEvent, Refusal, ResolveContext, Resolver } from './callbacks/protocol.ts'

// Recipes
export { builtinRecipeIds, DEFAULT_RECIPE, describeBuiltinRecipes, loadBuiltinRecipe, parseRecipe, recipeRef, resolveRecipe } from './recipe.ts'
export type { Recipe, RecipeRef, RecipeSpec, RecipeStep } from './recipe.ts'

// Server and engine
export { DELETE_AFTER_LABEL, ERROR_CODES, IDEMPOTENCY_LABEL, readAll, SandboxError } from './backend.ts'
export type {
  Backend,
  BackendCheck,
  BackendStatus,
  Capabilities,
  CreateOptions,
  Endpoint,
  ExecOptions,
  ExecResult,
  FileInfo,
  Machine,
  MachineState,
  NetworkPolicy,
  NetworkPolicyKind,
  PortRequest,
  PublishedPort,
  ReadRange,
  Resources,
  Snapshot,
  SnapshotOptions,
  WriteOptions,
} from './backend.ts'
export {
  checkCreate,
  checkLabels,
  collectStream,
  deleteAfterOf,
  hasLabels,
  LABEL_KEY_PATTERN,
  LABEL_VALUE_PATTERN,
  networkPolicyKind,
  requireCapability,
  sliceRange,
  streamBytes,
} from './contract.ts'
export { BACKEND_ENV, BACKEND_NAMES, createBackend, detectHost, selectBackend, smolvmSupport } from './backends.ts'
export type { BackendName, BackendSelection, BackendSource, HostInfo, HostSupport } from './backends.ts'
export {
  BASE_IMAGE,
  BASE_LABEL,
  BASE_PREFIX,
  DEFAULT_DELETE_AFTER,
  DESKTOP_USER,
  DURATION_PATTERN,
  IMAGE_LABEL,
  MACHINE_PREFIX,
  NAME_PATTERN,
  parseDuration,
  parseEnv,
  RECIPE_DIR,
  RECIPE_LABEL,
  RUNTIME_DIR,
  RUNTIME_LABEL,
  Sandboxes,
  VIEWER_PORT,
} from './sandboxes.ts'
export { endpointUrl, loopbackPort } from './net.ts'
export type {
  AccessibleNode,
  CallbackAnswer,
  CallbackRequest,
  InputAction,
  RecordingInfo,
  SandboxesOptions,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxInfo,
  Screenshot,
  StartOptions,
  Started,
  StepResult,
  UiAct,
  UiQuery,
  UiWait,
  UiWaited,
} from './sandboxes.ts'
export { Jobs } from './jobs.ts'
export type { JobEvent } from './jobs.ts'
export { appRouter } from './router.ts'
export type { AppRouter, Context, DoctorBackend, DoctorCheck, ListedSandbox } from './router.ts'
export { processAlive, readStarts, reap, recordStart, START_LABEL, startsDir } from './reaper.ts'
export type { ReapAction, ReapOptions, ReapReport, ReapSkip, RecordedStart, StartRecord } from './reaper.ts'
export { buildImage, desktopImageDir } from './image.ts'
export type { ImageBuild, ImageBuildOptions } from './image.ts'
export { serve } from './serve.ts'
export type { Served, ServeOptions } from './serve.ts'
export { hostId, KIND_LABEL, MANAGER_LABEL, ownerLabels, standaloneLabels } from './labels.ts'
export { configDir, stateDir } from './paths.ts'
