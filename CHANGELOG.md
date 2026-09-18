# Changelog

All notable changes to the `astorlm` package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.2.2] — 2026-09-18

Documentation only. No runtime changes, no API changes — `dist/` is identical
to 0.2.1 apart from the version string. npm renders the README of the newest
published version, so the corrections below cannot reach the package page
without a release of its own.

### Fixed

- **The entrypoint map contradicted the code.** "Module Layout" claimed the
  agnostic core lives behind `astorlm/core`, the opposite of the intro and of
  `src/core.ts`, which is the Node runner. `astorlm` is the agnostic barrel.
- **The diagram did not render on npm.** npm does not support Mermaid, so the
  package page showed a raw wall of `graph TD` / `subgraph` / `-->` three
  screens below the table that sells "No graph DSL" as the difference from
  LangGraph. It is now a plain text block that renders identically on npm and
  GitHub, and it carries the agnostic/Node split per entrypoint — the fact the
  diagram was burying in its subgraph labels.
- Four internal links pointed at the wrong section, including
  `experimental/edge-boost` and `steering` in the feature tables.

### Added

- Sections for four public surfaces the README never documented:
  `astorlm/prompt` (`compilePrompts`, `formatPromptReport`),
  `astorlm/experimental/contract` (`createContractHooks`, `ContractValidator`),
  `generateObject` (exported from the main barrel with no prose at all) and
  `runGoalLoop` (two unlinked words in a table). Every subpath declared in
  `package.json#exports` now has a documented section.

## [0.2.1] — 2026-09-18

Metadata only. No runtime changes, no API changes — `dist/` is identical to
0.2.0 apart from the version string.

### Changed

- `package.json#description` is now "The agent loop as a library: an
  embeddable, SDK-first agentic runtime for TypeScript." It is the tagline npm
  shows in search results, so it says what the package is rather than what it
  was inspired by. npm renders the description of the newest published version,
  which is the reason this ships as a release of its own.

## [0.2.0] — 2026-09-18

Everything below landed after the initial release: structured output, the
edge-boost profile for weak models, MCP Apps UI, a WASM code sandbox,
first-class embeddings, the full observability stack (tracing, metrics, replay,
evals) and the repository infrastructure for going public.

### Fixed — Four experimental modules never shipped

The observability stack was documented and tested but not packaged.

- `tracing`, `tracing/otel`, `metrics`, `replay` and `evals` existed under
  `src/experimental/`, had passing tests and were described in the README, but
  appeared in neither `tsup.config.ts` nor `package.json#exports`. They never
  reached `dist/` — `dist/experimental/evals` was an empty directory — so
  `import ... from 'astorlm/experimental/tracing'` failed with
  `ERR_PACKAGE_PATH_NOT_EXPORTED` for anyone installing the package. Tests
  never caught it because they import from `src/`, not from the built package.
- All five are now built and exported.
- `test/package-exports.test.ts` guards the contract: the tsup entry list and
  the exports map must agree, every export must point at the file its entry
  produces, and any `src/experimental/<name>/index.ts` must be exported.

### Fixed — `AnthropicProvider` sent a thinking config current models reject

- The provider hardcoded `thinking: { type: 'enabled', budget_tokens: n }`. That
  form is removed on current models, which reject it with a 400 — the code
  compiled and failed only at runtime, and only for callers who set `thinking`.
- `thinking` now accepts `{ type: 'adaptive', display? }` (the current form, in
  which the model decides how much to think) and keeps `{ budget_tokens }` for
  callers still targeting older models.
- New `effort` option (`'low'` … `'max'`), mapped to `output_config`.
- `contextLimit` is now an option instead of a hardcoded 200000. The default is
  unchanged and deliberately conservative: compacting earlier than necessary
  wastes turns, compacting later than necessary fails the request. Callers on
  larger-context models raise it.
- `test/anthropic-wire.test.ts` gives this provider its first wire-level
  coverage, asserting the request body against a real HTTP server.

### Fixed — Flaky heartbeat tests

- `heartbeat stops automatically via maxTicks and timeoutMs` failed roughly one
  run in five: it slept a fixed 40 ms and then asserted an exact tick count,
  which is a bet on timer scheduling that parallel load loses. Waits for
  something to happen now poll with a deadline; waits asserting that nothing
  happens stay as real sleeps, since those can only produce false passes.

### Changed — English-only strings and honest example pointers

- `AuthStorage.require` threw its error in Spanish (`Falta credencial: ...`).
  It is a message consumers of an English-language library see at runtime, so
  it now reads `Missing credential: <key>. Set it in the environment or pass it
  as an override.` Two leftover Spanish comments in `tools/define.ts` were
  translated as well. The Spanish stopword list in the error registry's
  fingerprinting stays — that one is data, not prose.
- The README and CONTRIBUTING pointed at "the examples repo" as if it were
  reachable. The examples are published separately, so the pointers now say so
  instead of sending readers somewhere that does not exist yet.

### Changed — Dependency refresh

- `openai` 4.104 → **7.17** (three majors), `@anthropic-ai/sdk` 0.40.1 → **0.126**,
  `@modelcontextprotocol/sdk` 1.29 → 1.30, `quickjs-emscripten` 0.31 → 0.32,
  `vitest` 2 → **4**, `tsx` 4.21 → 4.23.
- `vitest` stops at 4 rather than 5 on purpose: 5 declares
  `engines: ^22.12 || ^24 || >=26`, which excludes Node 20 — the floor this
  package promises. CI was passing on Node 20 with vitest 5 only because
  nothing enforces `engines`, so the oldest supported runtime was being
  verified by a runner that does not claim to work there. Version 4 declares
  `^20 || ^22 || >=24` and covers the whole matrix honestly.
- Held back on purpose: **`zod` 3 → 4** is a public-API migration, since
  consumers hand their own Zod schemas to `tool()` — it needs its own change.
  **`typescript` 5 → 7** typechecks clean but breaks the `.d.ts` build under
  tsup. **`@types/node`** stays on 22 to match the supported Node floor
  (`engines: >=20`); newer type packages describe APIs the supported runtimes
  do not have.
- GitHub Actions bumped: `checkout` v5 → v7, `setup-node` v5 → v7,
  `pnpm/action-setup` v4 → v6.

### Added — Wire-level tests for `OpenAIProvider`

- `test/openai-wire.test.ts` runs the agent against a real (minimal)
  OpenAI-compatible HTTP server instead of a mock provider, covering the
  request body, streamed text deltas, a tool call reassembled from split
  `arguments` fragments, the tool-result round-trip, and usage on the final
  chunk. The rest of the suite stops at the provider boundary, so nothing
  exercised the SDK's HTTP and SSE paths — exactly what moves when `openai`
  crosses a major version.

### Added — Project infrastructure

Repository plumbing ahead of the public release. No runtime changes.

- **CI workflow** (`.github/workflows/ci.yml`): typecheck, test, build and
  `pnpm pack` on Node 20/22/24 (Linux) plus Node 22 on Windows.
- **Community files**: `CONTRIBUTING.md` (setup, architecture map, conventions,
  PR expectations), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) and
  `SECURITY.md` — the latter includes an explicit threat model covering the
  executor, path confinement, prompt injection and MCP trust boundaries.
- **Issue and PR templates**, plus a monthly Dependabot config for npm and
  GitHub Actions.
- De-flaked `executor-local.test.ts`: it waited a fixed 200 ms for a spawned
  interpreter to produce output, which is not enough while the rest of the
  suite runs in parallel. It now polls with a deadline.
- **README opening rewritten**: tagline, a runnable quickstart, a short
  comparison against coding CLIs / agent frameworks / vendor SDKs, a
  capability table and a table of contents. The reference material below it is
  unchanged.
- **Brand assets** in `assets/`: bandoneón-bellows logo (lockup in light and
  dark, standalone mark, and a rounded-square app icon), now used in the README
  header alongside status badges.
- `packageManager` is pinned in `package.json` so CI and contributors resolve
  the same pnpm version.
- `files` now ships `assets/`, `CHANGELOG.md` and `LICENSE` in the npm tarball.
- **Package metadata**: `author`, `repository`, `homepage`, `bugs` and
  `publishConfig.access` — without them the npm page would carry no link back
  to the repository or its issue tracker.

### Fixed — `LocalExecutor` orphaned shell children on POSIX

Surfaced by the new CI matrix, which runs the suite on Linux for the first time.

- `spawn(cmd, { shell: true })` returns the pid of the shell, not of the command
  it runs. `kill()` signalled only that shell, so the real process survived,
  kept the inherited stdio pipes open, and `'close'` never fired — meaning
  `getOutput()` reported `running: true` forever and the process was orphaned.
  Windows already handled this with `taskkill /T`; POSIX did not.
- POSIX spawns are now detached into their own process group and terminated
  with a negative pid, so the whole tree goes down. This covers `kill()`,
  `dispose()`, `exec()`'s timeout path and abort via `abortSignal` (Node's own
  `signal` handling also reaches the shell only).

### Added — Structured output (`generateObject`)

Typed, schema-validated model output as a first-class API.

- `generateObject({ provider, schema, prompt, ... })` returns `{ object, message, sessionId?, mode }`
  where `object` is typed and validated against a Zod schema.
- Two strategies behind one call:
  - **`'tool'` (terminal tool)** — the general primitive. Registers a synthetic
    tool whose schema is the desired output and instructs the model to call it;
    its input *is* the object. Works with any provider, composes with other
    tools, and reuses the agent's tool validation + repair loop (an invalid
    object comes back as an error `tool_result` the model self-corrects).
  - **`'native'` (response_format)** — for the no-tools, one-shot case. Maps to
    OpenAI `response_format: json_schema` (constrained decoding). Repairs by
    re-asking with the validation error when the provider lacks native support.
  - **`'auto'` (default)** — `'native'` when there are no tools and the provider
    is OpenAI-compatible; `'tool'` otherwise.
- `OutputFormat` type + `ProviderStreamOptions.outputFormat`. `OpenAIProvider`
  maps it to `response_format` (only when no tools are sent in the same call).
- `CreateAgentOptions.stopOnToolNames` / `runLoop` support: the loop returns
  immediately after a named tool runs without error (powers the terminal-tool
  primitive; also useful standalone).
- `GenerateObjectError` thrown when the model never produces a valid object.

### Added — Skills subsystem (Agent Skills spec, May 2026)

A complete, spec-aligned skills implementation. Skills are reusable
markdown instructions the agent loads on demand; this drop introduces the
data model, three activation modes, two built-in sources, the canonical
filesystem pattern, and strict frontmatter validation.

#### Data model

- `Skill` / `SkillMetadata` / `SkillSource` / `SkillMode` types under the
  agnostic `astorlm` barrel. Skills are pure data — markdown body plus
  metadata — and the SDK ships no opinion about where they live.
- `Skill.path?: string` — absolute path to the SKILL.md when the source
  exposes one (filesystem sources do; in-memory sources do not). Required
  by the `'filesystem'` activation mode.
- `Skill.metadata?: Record<string, string>` — catch-all that captures any
  frontmatter field other than `name` and `description` (`version`,
  `tags`, `license`, …). The SDK does not interpret these; they are
  available to consumer policy code (filtering, gating, etc.). Forward-
  compatible with future spec extensions.

#### Sources (`SkillSource`)

- `createInMemorySkillSource({ name, skills })` — host-supplied skills,
  useful for tests, embedded resources, or skills materialised from a
  database. Accepts optional `metadata` per skill.
- `createFileSystemSkillSource({ dir, name? })` (in `astorlm/node`) —
  reads `<dir>/<name>/SKILL.md` files from disk; populates absolute
  `path` and extra `metadata` from the frontmatter.
- The session accepts any number of sources via `skillSources: SkillSource[]`.
  Conflicts (two sources offering the same skill name) throw at session
  creation; there is no silent override.

#### Activation modes (`skillMode`)

- `'filesystem'` — **the canonical Agent Skills pattern** adopted by
  Claude Code, OpenAI Codex and Gemini CLI. The system prompt lists each
  skill's name, description and absolute SKILL.md path; the agent reads
  the body with the standard `read` tool when triggered. No meta-tool is
  registered. Most robust across model sizes; unlocks bundled
  `scripts/`, `references/`, `assets/` for free via `read` / `bash`.
- `'on-demand'` (default) — the system prompt lists only name +
  description; the SDK auto-registers a `load_skill` meta-tool the model
  invokes to materialise a body. Scales to many skills without bloating
  context, but depends on the model being willing to invoke a meta-tool.
- `'all'` — every body is concatenated into the system prompt at session
  init. Cheapest at runtime; eats context. Use for small, always-relevant
  skill sets.

#### Spec-aligned frontmatter validation

- `name`: 1–64 chars, `^[a-z0-9][a-z0-9-]*$`, reserved identifiers
  (`anthropic`, `claude`) blocked.
- `description`: 1–1024 chars, no XML tags (e.g. `<foo>` / `</foo>`) —
  they can be mistaken for native tool-call syntax by some models.
- The `name` from the frontmatter must match the directory name on the
  filesystem source (drift throws a clear error with the file path).
- Public validators exposed for programmatic use: `validateSkillName`,
  `validateSkillDescription`, `validateSkillSpec`, `SkillValidationError`,
  `SKILL_VALIDATION_LIMITS` (frozen).

#### Other public exports

- `SkillRegistry` — aggregates one or more `SkillSource`s, dedupes by
  name with throw-on-conflict, caches loaded bodies.
- `parseSkillFrontmatter(content)` — minimal YAML-frontmatter parser
  tailored for SKILL.md files (no dependency added).
- `renderSkillsBlock(skills, mode)` — renders the system-prompt block
  for any of the three modes.
- `createLoadSkillTool(registry)` — the `load_skill` meta-tool used by
  `'on-demand'`.

#### Persistence

- Bodies returned by `load_skill` land as `tool_result` blocks in the
  conversation, so when sessions are persisted via `FileSessionManager`,
  loaded skills survive resumes for free — no re-invocation needed.

### Notes / gotchas baked into the implementation

- The `<available-skills>` block in `'on-demand'` mode lists entries as
  markdown bullets with the name in backticks
  (`` `pptx-deck` — Build a PowerPoint deck… ``). A YAML-ish layout
  (`name: pptx-deck\n  description: …`) was tried first and rejected
  because it primes Llama-family models to leak the literal `name:`
  prefix into their native tool-call syntax (`<function=name: foo>`),
  making the provider reject the call with `tool_use_failed`. Backticks
  + em-dash read as prose to all models and remove the ambiguity.
- Paths in `'filesystem'` mode are rendered with forward slashes
  regardless of host OS. Node accepts them on Windows, and the change
  keeps the JSON the model emits for the `read` tool call free of heavy
  backslash escaping (which has been observed to confuse Llama 4 Scout
  into emitting malformed `<function=name=…>` syntax).
- File-system source error messages always include the absolute path of
  the offending SKILL.md.

### Tests

- 9 new test files: `skills-parseFrontmatter`, `skills-registry`,
  `skills-inMemorySource`, `skills-integration`, `skills-fileSystemSource`,
  `skills-validate`, `skills-filesystem-mode`. 152 tests passing total.

### Docs

- New "Skills (loadable knowledge packs)" section in `README.md` with all
  three modes, frontmatter rules table, an example skill featuring extra
  frontmatter fields (`version`, `tags`, `license`), in-memory skill
  example with `metadata`, and the canonical `'filesystem'` setup.
- `astorlm-examples/examples/15-skills-playground/` (separate repo) ships
  nine ready-to-run variants (00–08) covering diagnostic, on-demand FS,
  `'all'` mode, in-memory, custom remote source, multi-source, persistence
  round-trip, host-side auto-router, and the canonical `'filesystem'`
  pattern. Validated end-to-end against Llama 4 Scout via Groq.

---

## [0.1.0] — Initial release

Embeddable, runtime-agnostic agentic TypeScript SDK with:

- Multi-turn agent loop with parallel tool execution
- Anthropic + OpenAI-compatible providers
- Session persistence and branching (FileSessionManager)
- Pluggable `Executor` for shell commands (Local + Docker)
- Session hooks (permission gating, pre/post tool wrapping)
- Context optimizer and opt-in retry policy
- MCP client (stdio + HTTP)
- Experimental federated error registry under
  `astorlm/experimental/error-registry`.

[unreleased]: https://github.com/aralde/astorLM/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/aralde/astorLM/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/aralde/astorLM/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/aralde/astorLM/releases/tag/v0.2.0
