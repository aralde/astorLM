# Security Policy

## Supported versions

`astorlm` is pre-1.0. Security fixes land on `main` and ship in the next
release; older minor versions are not backported.

| Version | Supported |
| ------- | --------- |
| `0.x` (latest) | ✅ |
| older `0.x` | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security reports.**

Use GitHub's private reporting instead:
[Report a vulnerability](https://github.com/aralde/astorLM/security/advisories/new).

Include, as far as you can:

- the affected version, entrypoint and platform,
- a minimal reproduction,
- the impact you believe it has.

You can expect an acknowledgement within a few days. Once a fix is ready, it is
released and the advisory is published with credit to you, unless you prefer to
stay anonymous.

## Threat model — what this library does and does not protect

`astorlm` is a library that lets a language model run tools on your behalf.
Understanding the boundaries matters more than any single report:

- **The default `Executor` runs commands on the host.** `LocalExecutor` gives
  the model the same privileges as the process embedding the library. It is a
  convenience backend, not a sandbox. If the model's input is untrusted, use
  `DockerExecutor` (OS-level isolation) or a custom `Executor` of your own.
- **`resolveSafe` constrains paths to `cwd`, not the shell.** The built-in
  `read`/`write`/`edit` tools refuse to escape the working directory, but the
  `bash` family executes whatever command it is given. Path confinement is not
  command confinement.
- **`QuickJsCodeRunner` is the sandboxed tier.** It runs self-contained source
  inside a memory-safe WASM runtime with no filesystem, network or host
  syscalls unless you grant them explicitly.
- **Prompt injection is a real risk for any agent.** Content the model reads —
  files, web pages, MCP tool results — can contain instructions. The
  `beforeToolExecution` hook is the intended enforcement point: use it to
  require authorization for sensitive tools. See `restrictToolsHook` for a
  ready-made allowlist.
- **MCP servers are trusted code.** `mountMcpServer` runs the transport you
  configure and does not validate tool inputs — the server is expected to. Only
  mount servers you trust.
- **Credentials.** API keys are read from the environment through `AuthStorage`
  and passed to providers. The library does not persist them. Session files
  written by `FileSessionManager` contain conversation content, which may
  include whatever the model or your tools put there — treat session
  directories as sensitive.

Reports about these documented behaviours are not vulnerabilities in
themselves, but reports showing a way to *bypass* a boundary the library claims
to enforce definitely are.
