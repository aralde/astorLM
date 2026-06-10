/**
 * Experimental `wasm-runner` module.
 *
 * ⚠️ Volatile API. Signatures may change between minor releases. What is
 * stable: the conceptual primitive (a capability-empty `CodeRunner` that
 * evaluates source code in a WASM sandbox with no host access).
 *
 * This is the runtime-agnostic isolation tier: unlike `DockerExecutor` it needs
 * no daemon and runs anywhere WASM does (Node, Deno, browser, edge). It does
 * NOT replace `Executor` — it runs self-contained snippets, not shell commands.
 *
 * Design notes: see the wasm-runner proposal under .docs/.
 */
export { QuickJsCodeRunner } from './quickjs.js'
export type { QuickJsCodeRunnerOptions } from './quickjs.js'
export { createCodeRunnerTool } from './tool.js'
export type { CreateCodeRunnerToolOptions } from './tool.js'

// Re-export the core abstraction for convenience so consumers can type their
// own runners without reaching into the core barrel.
export type { CodeRunner, RunCodeOptions, RunCodeResult } from '../../coderunner/types.js'
