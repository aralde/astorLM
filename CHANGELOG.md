# Changelog

All notable changes to the `astorlm` package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.2.0] — 2026-09-16

Everything below landed after the initial release: structured output, the
edge-boost profile for weak models, MCP Apps UI, a WASM code sandbox,
first-class embeddings, the full observability stack (tracing, metrics, replay,
evals) and the repository infrastructure for going public.

### Added — Project infrastructure

Repository plumbing ahead of the public release. No runtime changes.

- **CI workflow** (`.github/workflows/ci.yml`): typecheck, test, build and
  `pnpm pack` on Node 20/22/24 (Linux) plus Node 22 on Windows.
- **Community files**: `CONTRIBUTING.md` (setup, architecture map, conventions,
  PR expectations), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) and
  `SECURITY.md` — the latter includes an explicit threat model covering the
  executor, path confinement, prompt injection and MCP trust boundaries.
- **Release workflow** (`.github/workflows/release.yml`): publishes to npm with
  provenance when a `v*` tag is pushed, after re-running typecheck, tests and
  build and verifying the tag matches `package.json`.
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

[unreleased]: https://github.com/aralde/astorLM/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/aralde/astorLM/releases/tag/v0.2.0
