# Contributing to astorlm

Thanks for taking the time to contribute. This document covers how to get the
project running locally, the conventions the codebase follows, and what a good
pull request looks like.

## Getting started

Requirements: **Node >= 20** and **pnpm** (the repo pins its version through the
`packageManager` field — `corepack enable` is enough to pick it up).

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm build       # tsup -> dist/ (ESM + CJS + .d.ts)
```

`pnpm test:watch` and `pnpm dev` (tsup in watch mode) are available while you
iterate.

### Running the examples

Runnable examples live in a companion repository, published separately from
this one, which consumes this package through a `file:` link. If you have it
checked out beside this repository, build the library first, then install the
examples:

```bash
cd astorlm && pnpm build
cd ../astorlm-examples && pnpm install
```

Any change to the library needs a fresh `pnpm build` before the examples see it.

## Architecture in one minute

- `src/index.ts` — the "everything" barrel: the runtime-agnostic core plus a
  re-export of the Node runner.
- `src/core.ts` — the Node barrel (`createLocalAgent`, `FileSessionManager`,
  `AstorAgent`, executors, MCP).
- `src/agent/` — the loop, session, optimizer, retry, event bus.
- `src/tools/` — the `tool()` helper, the registry, and the built-in tools.
- `src/executor/` — the swappable command backend (`LocalExecutor`,
  `DockerExecutor`).
- `src/experimental/<feature>/` — volatile APIs, each behind its own subpath
  export.

If you are looking for where something is exported from, read `src/index.ts` and
`src/core.ts` first — they are the map of the public API.

## Conventions

These are enforced by review, so please follow them:

- **English everywhere in this repo.** Comments, JSDoc, identifiers, error
  messages, test titles and Markdown files are all written in English. The one
  deliberate exception is `DEFAULT_SYSTEM_PROMPT` and the other strings the
  agent sends to the model — do not translate those without an explicit request.
- **ESM with explicit `.js` extensions** in relative imports, even from
  TypeScript sources. The package is `"type": "module"`.
- **Keep the core runtime-agnostic.** Anything reachable from `src/index.ts`
  without passing through `core.ts` must not import Node built-ins. If you need
  `node:fs` or `node:child_process`, it belongs in `src/core.ts`,
  `src/executor/`, `src/skills-node/` or an experimental module.
- **Experimental APIs go in `src/experimental/<feature>/`** with their own entry
  in `package.json#exports`. Never re-export them from the main barrel — the
  subpath is what signals instability.
- **No global state.** Multiple agents must be able to coexist in one process.
- **Tools throw plain `Error`s.** The registry catches them and returns
  `{ isError: true, output }` without breaking the loop.
- **Path safety:** use `resolveSafe(cwd, path)` from `src/util/fs.ts` so tools
  cannot escape the working directory.
- **Tools are defined with `tool()` and a Zod schema.** The only place a `Tool`
  is built by hand is the MCP adapter.
- **Built-in bash tools talk to the `Executor`**, never to `child_process`
  directly. The executor indirection is what makes local/Docker/remote
  swappable.

## Tests

Tests live in `test/` and run on vitest. `test/mock-provider.ts` implements the
`Provider` interface with scripted events — use it for deterministic loop tests
instead of hitting a real model.

Every behavioural change needs a test. New modules should ship with their own
`test/<feature>.test.ts`. The full suite must be green before you open a PR.

## Pull requests

1. Branch off `main` (`git switch -c feat/my-change`).
2. Keep one logical change per PR — it makes review and the changelog sane.
3. Run `pnpm typecheck && pnpm test && pnpm build` locally.
4. Add an entry under `## [Unreleased]` in `CHANGELOG.md` describing the change
   from a consumer's point of view.
5. If you added or changed public API, update `README.md` in the same PR.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`), with an optional
scope such as `feat(provider):` or `fix(loop):`.

## Reporting bugs and proposing features

Use the issue templates. For anything security-related, do **not** open a public
issue — follow [SECURITY.md](SECURITY.md) instead.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
