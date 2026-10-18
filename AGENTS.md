# AGENTS.md

Orientation for coding agents (and humans) working in this repository.

## What this project is

Star Gate (code name **DSG**) is a zero-dependency Node.js gateway that fronts a
local fleet of OpenAI-compatible inference servers. Three long-running processes:

| Process | Entry | Port (default) |
| --- | --- | --- |
| Gateway core | `ds4-gateway/gateway.mjs` | `30001` (behind the Door) |
| Continuity Door | `ds4-gateway/door.mjs` | `30000` (client-facing) |
| Dashboard | `ds4-gateway/dashboard.mjs` | `30010` (loopback) |

The demo dashboard uses `30011` (`npm run ui:demo`).

## Ground rules

1. **Never commit private data.** `config.local.json`, `runtime/`, credentials,
   logs, model files, machine names and deployment notes stay out of Git. The
   privacy guard is a guardrail, not a proof; read
   `docs/publication-policy.md` before adding docs.
2. **Do not break the contract.** Preserve byte-exact forwarding, durable
   affinity, per-worker FIFO admission, no automatic replay after ambiguous
   failures, unknown values labeled unknown, and the loopback/CSRF/private-socket
   boundary around operator controls.
3. **No runtime dependencies.** The core uses only the Node standard library.
   Adding a package needs a strong reason and a discussion.
4. **Tests are fixtures.** `npm test` starts local HTTP servers and temporary
   state. Never point tests at real workers, GPUs, or an operator's config.
5. **Update the map.** If you change a command, guarantee, or limitation, update
   `README.md` and the relevant `docs/` page in the same change.

## Commands

```sh
npm run check            # syntax check all .mjs and shell scripts
npm test                 # main suite (88 files, local fixtures)
npm run continuity:test  # client continuity / Door behavior
npm run data:test        # telemetry and evidence math
npm run recovery:test    # Node + Python recovery adapters
npm run privacy-check    # tracked files and working copies
npm run privacy:test
npm run hooks:install    # opt in to the staged-file pre-commit hook
npm run doctor           # read-only config/port/path checks
npm run setup -- --controls
npm start | npm run door | npm run ui
npm run ui:demo          # synthetic dashboard, no fleet needed
```

Run one test file directly:

```sh
node --test ds4-gateway/routing-v2.test.mjs
```

Python satellites (optional features) live beside their modules, e.g.
`python3 -m unittest discover -s ds4-gateway -p 'recovery_*_test.py' -v`.

## Repository map

```text
ds4-gateway/          gateway, door, dashboard, ~150 modules and their tests
  ui/                 dashboard HTML/CSS/JS and generated icons
  agent-*.mjs         scoped agent API and CLI
  routing-*.mjs       placement, estimates, shadow, v2 lane measurement
  recovery*.mjs/.py   opt-in service recovery adapters
  media-*.mjs/.py     experimental H3/ACE-Step job support
  spark-*.mjs/.py     DGX Spark enrollment, discovery, services
  hermes-*.mjs        legacy Genie/Hermes profile helpers (unsupported)
scripts/              setup, doctor, check, privacy, hooks, icons, telemetry
examples/             generic config, demo dashboard, Spark build recipes
docs/                 user documentation (indexed at the end of README.md)
.github/workflows/    CI: syntax, privacy, Node tests, Python adapter tests
```

## Conventions

- ESM `.mjs`, no TypeScript, no bundler, 2-space indent, single quotes.
- Tests use `node:test` + `node:assert/strict`; name files `*.test.mjs`.
- Prefer small pure modules over growing `gateway.mjs` / `dashboard.mjs`.
- Errors are explicit strings; never silently clamp or invent a measurement.
- Measurements carry evidence labels (`measured`, `stale`, `cold`, `unknown`);
  keep that distinction.
- UI assets are validated as a complete bundle at startup; reload only the
  dashboard after a UI change.

## Git hygiene

- Commit identity must be a GitHub noreply address or an explicitly approved
  public address (`git config --local dsg.publicEmail ...`). The hook enforces it.
- Stage new files before running `npm run privacy-check`; it inspects index blobs.
- Do not rewrite published history or force-push shared branches without an
  explicit owner decision.

## Known rough edges

- Some docs still mention removed Genie/Hermes/Telegram features.
- Routing v2 is experimental and flag-gated.
- The dashboard is a single-page app assembled from string templates; large UI
  edits need a manual pass in `npm run ui:demo`.
- CI runs on Linux and macOS; platform-specific recovery paths are only partially
  covered by fixtures.

When in doubt, read `README.md`, `docs/simplified-system.md`, and the test file
next to the module you are changing.
