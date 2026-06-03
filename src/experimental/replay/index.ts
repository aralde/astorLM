/**
 * Experimental `replay` module — deterministic record & replay.
 *
 * ⚠️ Volatile API behind a dedicated subpath. Runtime-agnostic: capture happens
 * at the provider boundary and the `Recording` is a plain serializable object,
 * so persistence is just `JSON.stringify` + your storage of choice.
 *
 * ```ts
 * // record
 * const rec = createRecordingProvider(realProvider)
 * const agent = await createAgent({ provider: rec, ... })
 * await agent.run('...')
 * fs.writeFileSync('run.json', JSON.stringify(rec.getRecording()))
 *
 * // replay later — no network, no tokens, same events
 * const recording = JSON.parse(fs.readFileSync('run.json', 'utf8'))
 * const replay = await createAgent({ provider: createReplayProvider(recording), ... })
 * await replay.run('...')
 * ```
 */
export { createRecordingProvider } from './recordingProvider.js'
export type { RecordingProvider, RecordingProviderOptions } from './recordingProvider.js'
export { createReplayProvider } from './replayProvider.js'
export type { ReplayProviderOptions } from './replayProvider.js'
export type { Recording, RecordedTurn } from './types.js'
