<!--
Thanks for the pull request. Keep one logical change per PR — it keeps review
and the changelog readable.
-->

## What changes

<!-- A short description from a consumer's point of view. -->

## Why

<!-- The problem this solves. Link the issue it closes, if there is one. -->

Closes #

## How it works

<!--
For anything non-trivial: the approach you took, and the alternatives you
rejected. If this touches the loop, say whether it is additive or a behaviour
change.
-->

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] `pnpm build` passes
- [ ] Tests cover the new behaviour (deterministic ones use `test/mock-provider.ts`)
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]`
- [ ] `README.md` is updated if the public API changed
- [ ] New or changed code is written in English (comments, JSDoc, errors, test titles)
- [ ] Nothing reachable from `src/index.ts` without going through `core.ts` imports a Node built-in
- [ ] Any unstable API lives under `src/experimental/<feature>/` with its own export, and is not re-exported from the main barrel

## Breaking changes

<!-- None, or: what breaks and what consumers have to do about it. -->

None.
