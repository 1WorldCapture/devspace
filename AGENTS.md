# DevSpace

DevSpace is a local development execution layer for MCP hosts such as ChatGPT and Claude. It gives a remote host workspace-scoped tools for reading, editing, searching, running commands, managing Git worktrees, reviewing changes, and coordinating bounded subagents on the user's machine.

Pi's SDK currently provides mature local coding primitives. DevSpace wraps those primitives in a Streamable HTTP MCP server and adds the product-specific boundaries around them: approved roots, workspace state, instructions, process sessions, worktrees, artifacts, review checkpoints, widgets, and subagent execution.

DevSpace owns tooling mechanics. The model receives only meaningful and actionable choices. The user sees outcomes. Tool definitions should not leak internal implementation, and they should not give the model options that the tooling can handle itself.

## Product model

These ideas should stay true as the project evolves:

1. **The host is the orchestrator.** DevSpace exposes clear capabilities and execution state. It should not hide the workflow inside an opaque, uninspectable agent loop.
2. **Everything happens in a workspace.** A workspace represents one local project directory or worktree plus the instructions and state accumulated while operating in it.
3. **Local authority stays explicit.** DevSpace runs with access to the user's machine. Roots, paths, commands, processes, credentials, and destructive operations must be treated as product boundaries.
4. **Subagents are bounded workers.** A subagent should have an explicit task, profile, working context, lifecycle, and result that the host can inspect and coordinate.
5. **Adapters stay at the edges.** Pi, MCP hosts, and model providers each have their own terminology and capabilities. Provider-specific behavior should not become the core domain model.
6. **Prefer composable primitives.** Build a small set of reliable operations that can be combined into larger workflows instead of baking every workflow into the server.

## Glossary

- **Host** — the MCP client presenting the agent experience and coordinating work.
- **Server** — the local DevSpace MCP server.
- **Workspace** — one opened directory or worktree and its accumulated instruction context.
- **`workspace_id`** — the opaque handle returned by `open_workspace` and reused for calls in that workspace.
- **Allowed root** — a configured filesystem boundary within which a workspace may be opened. It is not itself necessarily a workspace.
- **Checkout mode** — operating on an existing checkout supplied by the user.
- **Worktree mode** — operating in an isolated Git worktree.
- **Tool surface** — the tools exposed by a configured mode, such as minimal, full, or Codex-compatible.
- **Process session** — a long-running command tracked for later input, output, or termination.
- **Instruction file** — an `AGENTS.md` or `CLAUDE.md` discovered while navigating a workspace.
- **Subagent** — a bounded model invocation delegated and coordinated by the host.
- **Agent profile** — the model, provider, tools, and instructions used for a subagent.
- **Artifact** — an output surfaced for the host or user to inspect.
- **Review checkpoint** — stored state representing a coherent set of changes.
- **Widget** — host-rendered UI/Cards attached to an MCP response.

Use these terms precisely. In particular, do not use workspace, allowed root, checkout, and worktree interchangeably.

## Directory structure

```text
.
├── bin/            # npm launchers (devspace, devspace-agentd); pick source or dist at runtime
├── src/            # server, CLI, tools, subagents, persistence (tests sit next to sources as *.test.ts)
│   ├── db/         # SQLite client, schema, forward-only migrations
│   ├── tool-surfaces/  # host-specific tool sets (codex, claude) and shared tool helpers
│   └── ui/         # React MCP widgets (cards) and workspace web pages under ui/web
├── scripts/        # dev server, dev-state seeding, config schema generation, replay QA harness (qa/)
├── test/           # packaged-install smoke test and provider conformance replay (agents-replay/)
├── schema/         # generated, versioned config JSON schema
├── skills/         # skills shipped with the package
├── examples/       # example agent profiles
├── install/        # install.sh / install.ps1 bootstrap scripts
├── tools/oxlint/   # project lint rules
├── apps/macos/     # DevSpace.app menu bar app (SwiftPM); bundles Node + packed DevSpace, not in the npm package
├── website/        # standalone docs/landing site; its own npm package, not part of the server build
└── dist/           # build output (gitignored)
```

Where to start in `src/`:

- `server.ts` — MCP server setup, tool registration, and response wiring.
- `cli.ts` — `devspace` command entry point (`serve`, `init`, `doctor`, `agents`, ...).
- `workspaces.ts` — workspace lifecycle, instructions, skills, and profiles.
- `roots.ts` — allowed roots and path containment.
- `process-sessions.ts` — long-running process lifecycle.
- `git.ts`, `git-worktrees.ts` — Git and worktree operations.
- `local-agent-*.ts` — subagent configuration, providers, daemon, and execution.
- `artifact-*.ts`, `incoming-artifacts.ts` — artifact handling.
- `review-checkpoints.ts` — persisted change-review checkpoints.
- `config*.ts`, `user-config.ts` — config loading, schema, and legacy migration.

Start at the boundary named by the problem and follow the data. Keep policy in DevSpace, provider translation in adapters, and important behavior in schemas, types, checks, or explicit tool results rather than hidden prompt conventions.

## Build, run, and install

Use `pnpm` in this checkout. `website/` uses `npm` separately.

### How the launcher chooses code

`bin/devspace.js` runs `src/cli.ts` through `tsx` whenever `src/` exists beside it, and only falls back to `dist/cli.js` when it does not. Consequences:

- Running `bin/devspace.js` from a checkout (or an `npm link` of it) always runs current source; `dist/` is ignored.
- Only a packed install (`npm pack` tarball or the published package) exercises `dist/`.
- A checkout without `pnpm install` fails loudly instead of using stale `dist/`.

### Build

```bash
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` cleans `dist/`, then runs three independent outputs:

1. `vite build` — MCP widget cards from `src/ui/workspace-app.html` into `dist/ui`.
2. `vite build -c vite.web.config.ts` — workspace web pages from `src/ui/web` into `dist/web` (served under `/web/`).
3. `tsc -p tsconfig.build.json` — server and CLI into `dist/`, excluding `src/ui`, tests, and `src/test-support`.

`npm pack` runs `pnpm build` via `prepack`. Only `bin`, `dist`, `examples`, `schema`, `scripts`, `skills`, and `README.md` are packed.

### Run from source for development

```bash
pnpm dev:seed   # once per checkout/worktree: fork ~/.devspace config + state into .devspace-dev/
pnpm dev        # tsx watch on src/cli.ts serve, with DEVSPACE_CONFIG_DIR=.devspace-dev/config
pnpm dev:reset  # discard .devspace-dev/ and re-seed from the current normal installation
```

- `pnpm dev` refuses to start without seeded state and never touches the user's normal state.
- It listens on the same configured port as the installed server; stop the installed server first. The user's tunnel can keep running.
- There is no daemonized server: stop it with Ctrl-C (or by terminating the `serve` process). The subagent daemon is managed with `devspace agents daemon <status|stop|logs>`.
- See `DEVELOPMENT.md` for real-host QA details.

### Install this checkout as the user's global `devspace`

Install the packed tarball so the result matches what npm users get:

```bash
pnpm build
npm pack --pack-destination <dir>          # produces waishnav-devspace-<version>.tgz
npm install -g <dir>/waishnav-devspace-<version>.tgz
devspace -v && devspace doctor
```

- The installed server must be restarted to pick up a new build.
- The tarball keeps `package.json`'s version; it is indistinguishable from the published release with the same version unless the version is changed.
- npm may skip dependency install scripts (for example `koffi`); confirm with `devspace doctor` and a real `devspace serve` start rather than assuming.
- First start of a newer build migrates state forward: `~/.devspace/config.json` becomes `config.jsonc` (old file kept as `config.json.v1.0.bak`), and the SQLite database in `storage.stateDir` (default `~/.local/share/devspace`) is migrated. Migrations are forward-only, so back up both directories before installing a newer build over an older one.
- Restore the published package with `npm install -g @waishnav/devspace`.

### macOS screen capture

`capture_screen` is registered only on macOS and shells out to `osascript`, `screencapture`, and `sips`. macOS attributes Screen Recording permission to the app that launched DevSpace (the terminal), not to `devspace` itself; after granting it, that app and DevSpace must be restarted.

## Verification

```bash
pnpm typecheck          # src, scripts/qa, and test/agents-replay
pnpm lint               # oxlint with project rules (tools/oxlint)
pnpm test               # src/**/*.test.ts only
pnpm build
pnpm test:package-install   # packs, installs, and runs the launchers; slower
```

- Project lint rules are strict and non-standard: type assertions need a preceding `// SAFETY:` comment, and statements need readable blank-line spacing. Prefer validating untrusted data (for example with zod) over asserting types.
- `pnpm qa` replays scripted MCP calls against an isolated server and renders widgets in a local MCP Apps host (needs `agent-browser`); inspect the screenshots it produces.
- `pnpm qa:agents` replays subagent provider conformance against the built CLI; run `pnpm build` first. `--live` and `--record` use real providers.
- `website/` builds separately: `cd website && npm ci && npm run build`.
- `apps/macos/` (macOS only): `cd apps/macos && swift test`; `apps/macos/scripts/build-app.sh` builds and signs DevSpace.app. See `DEVELOPMENT.md`.
- A tool's MCP shape can be checked in-process with the SDK's `InMemoryTransport` and `Client` before testing with a real host.

## Security boundaries

Filesystem tools enforce approved-root containment. Shell commands run with the local user's authority and are not a general sandbox. Never imply that shell execution is contained merely because file tools are contained.

Resolve and validate paths before destructive actions. Do not broaden an allowed root, delete application state, expose a credential, or replace an existing process as a convenient fix.

Keep tunnel ownership and credentials with the user. DevSpace may operate through a user-controlled tunnel, but it does not own tunnel lifecycle or configuration.

## Diagnose the correct layer

A failure may belong to the host, MCP transport, DevSpace, a Pi adapter, a provider, a model, a tool implementation, or the target project. Preserve the original error and identify the failing boundary before changing code.

An adapter exception is not evidence that a model failed. A successful command is not evidence that a GUI opened, a host refreshed, or a user-visible workflow succeeded.

Do not expand DevSpace's responsibility while fixing a local symptom. Host UI, provider model naming, tunnel management, and duplicated review experiences require an explicit product decision.

## Verify the real path

Determine how the user will consume the change and verify that path. Behavior may differ between:

- the source checkout and the packaged `npm`/`npx` installation;
- a direct terminal client and a real MCP host;
- a fresh process and a server or host that needs restarting;
- checkout mode and worktree mode;
- Linux, macOS, and Windows Bash environments;
- minimal, full, and Codex-compatible tool surfaces;
- widgets enabled, disabled, or limited to change review.

State clearly when only a narrower proxy was verified. For model-facing schemas, inspect what the host receives. For UI and artifacts, inspect the rendered result rather than inferring success from the producing command.

## Trace affected contracts

When changing a cross-cutting concept, check every surface it actually reaches:

- MCP schema, handler, description, and response;
- workspace lifecycle and instruction loading;
- allowed-root and path-containment behavior;
- checkout and worktree modes;
- process and subagent lifecycle;
- tool-surface filtering;
- widgets, artifacts, and review checkpoints;
- persistence and migrations;
- packaged entry points, documentation, and examples.

This is a map, not a requirement to touch every surface on every change. Avoid both incomplete contracts and speculative edits.

## Pull requests

Only create or update a PR when explicitly asked, and read `CONTRIBUTING.md` first. Keep a PR focused on one coherent concern and use a conventional title such as `fix:`, `feat:`, `docs:`, `refactor:`, or `chore:`.

Write the body as a few natural paragraphs explaining the problem and solution. Include verification, risk, or migration context only when it helps the reviewer. Avoid generated boilerplate, commit inventories, file-by-file narration, generic checklists, and mandatory `Testing` sections.

For UI changes, include before/after images and a short interaction video when behavior changes. Inspect the final diff before filing. When available, use the `file-pr` workflow to file the PR and `babysit-pr` to monitor CI and reviews.

## Project taste

- Prefer explicit lifecycle and state over hidden autonomy.
- Make tasks, inputs, outputs, failures, and ownership inspectable.
- Keep subagent execution composable and independently testable.
- Preserve host and provider data unless DevSpace has a concrete reason to normalize it.
- Add compatibility behavior only for an identified consumer with a real upgrade path.
- Reuse glossary terms in schemas, types, documentation, and errors.
- Keep the execution layer small, reliable, and unsurprising.

## Handcraft

<!-- Human-maintained. Do not edit in agents-md skill updates. -->
