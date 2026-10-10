# Client config sync (Pi on a Windows PC)

Star Gate can hand a client its own setup, so a machine on the home network can
join the pool with one command and re-sync later without anyone copying files
around. This page is the operator view: what the gateway serves, what the
Windows script does, and how to read the reports it sends back.

## What is served

Three routes, all on the same `/v1` base URL the API already uses:

| Route | Method | Returns |
| --- | --- | --- |
| `/v1/client/pi` | GET | The client bundle: a schema-1 JSON description of the `dsg-pool` provider. |
| `/v1/client/pi/install.ps1` | GET | The Windows PowerShell sync script, with the live defaults already baked in. |
| `/v1/client/pi/report` | POST | The bounded status report the script sends back after each stage. |

The base URL inside the bundle is the address clients actually reach — the
Continuity Door's host and port, advertised from the **Share on LAN** address.
The bundle's `script_url` and `report_url` are **relative to** `base_url`, so
`base_url + script_url` is a complete URL. Do not add another `/v1`.

The routes are reverse-proxied by the Door and are **not** inference endpoints.
They are not on the inference allowlist, never enter scheduling, and never count
as model work.

### The bundle

The bundle advertises the served API key as the constant `none`. That is
deliberate: the home-LAN client contract uses the constant, and serving the
gateway's real `api_key` here would turn this route into a key-disclosure path.
If your install requires a real key, do not use this page's one-liner; configure
the client by hand.

The model id is the pool label (Star Gate's `model` setting). `contextWindow` is
the **live** pool context and `maxTokens` is capped to it, so a client is never
told it can emit more than the pool can accept.

`revision` is a SHA-256 over the semantic fields only. A re-fetch with no real
change returns the same revision, so a client can tell "nothing changed" from
"re-sync needed".

## The Windows script

The script is a committed template; the core injects a preamble carrying the
live base URL, the fallback URLs and the constant key. Body behaviour, in order:

1. Read the existing `%USERPROFILE%\.pi\agent\models.json` if it exists.
2. Back it up to `models.json.<yyyyMMddTHHmmssZ>.bak`.
3. Fetch the bundle — preferred host first, then each fallback URL.
4. Parse and validate the nested structure before writing anything.
5. Merge **only** `providers[dsg-pool]`. Every other provider is preserved and
   semantically unchanged. (The file is re-serialized, so do not expect
   byte-identical formatting; a re-parse deep-compare is the right check.)
6. Optionally **purge** other providers — see "Pinning a client to the pool".
7. Write atomically (temp file, then move over the target).
8. Validate the written file.
9. Optionally **adopt the served defaults** — default provider, default model and
   default thinking level in `settings.json`. This runs only after `models.json`
   is written and verified, so `pi` is never pointed at a provider that failed to
   land. `settings.json` is backed up to `settings.json.<stamp>.bak` first, and
   only `defaultProvider`, `defaultModel` and `defaultThinkingLevel` are ever
   touched — every other setting (packages, extensions, subagent config) is
   preserved.
10. Check whether `pi` is present and report its version.
11. Report each stage to `/v1/client/pi/report`.

`-Check` parses and validates without writing. `-Test` additionally runs a live
`pi -p` probe through the pool.

The script must run on Windows PowerShell 5.1 as well as PowerShell 7. Every
`ConvertTo-Json` call passes `-Depth 100`, because the default depth of 2
silently truncates the nested model structure.

## Checking the script without a Windows machine

`ds4-gateway/pi-client-script.test.mjs` asserts the script's text, but text
assertions cannot tell a valid scriptblock from an unclosed one, and this is the
one deliverable that has to run on a machine we do not own. A real PowerShell
parser closes that gap:

```sh
# any pwsh binary: local install, Homebrew, or a downloaded release tarball
DSG_PWSH=/path/to/pwsh node --test ds4-gateway/pi-client-script.test.mjs
```

With `DSG_PWSH` set, the suite renders the exact bytes the gateway serves, parses
them with `ds4-gateway/parse-check.ps1`, and fails on any parser error. Without
it the test is **skipped, never passed** — so it cannot quietly claim coverage it
did not get.

To exercise the whole flow on a non-Windows box (parse, merge, purge, backup,
settings adoption, the `pi -p` probe), point the script at a throwaway agent
directory and a local PowerShell:

```sh
PI_CODING_AGENT_DIR=/tmp/pi-agent-dir /path/to/pwsh -NoProfile \
  -File <served install.ps1> -Test
```

`-Check` parses and diffs without writing; it writes nothing and creates no
backup.

## Pinning a client to the pool

Two bundle fields change what the client ends up running, and both are
**off unless configured**. They are set per-install in `config.local.json`, under
`pi_client` (which shallow-merges over `ds4-gateway/pi-client-defaults.json`):

```json
"pi_client": {
  "purgeProviders": "all",
  "defaults": {"model": {"defaultThinkingLevel": "high"}}
}
```

- `purgeProviders` — `[]` (default) removes nothing. `"all"` keeps **only** the
  synced provider and deletes every other entry under `providers`. A named array
  removes just those. It is roster-independent on purpose: a hardcoded list of
  every other provider would rot as the fleet changes and silently miss one. The
  removals happen after the backup, so they are recoverable.
- `defaults.model.defaultThinkingLevel` — `off | minimal | low | medium | high |
  xhigh | max`, defaulting to `high` when the key is absent. Set it to `null` to
  serve no default level at all, in which case the script **removes** the key and
  the client keeps its own setting. Any other value is refused at build time with
  `Unknown default thinking level`, rather than handed to a client that could not
  map it.
- `defaults.model.defaultProvider` / `defaultModel` default to the synced
  provider and the pool label; override only to point at something else.

`defaults.apply` is set by the builder, not the operator. Set it to `false` only
to serve a bundle with no default-model section at all, in which case step 9 is
skipped.

Because `defaults` and `purgeProviders` are part of the bundle's semantic
fields, changing either changes `revision` — an already-synced client will see a
different revision and know a re-sync will do something.

## Running it

On a Windows PC on the same network, open PowerShell and run the command shown
in **Settings → Share on LAN → Pi setup for a Windows PC**:

```
powershell -c "irm <base>/client/pi/install.ps1 | iex"
```

**Integrity note.** `irm ... | iex` fetches and executes code over plain HTTP
with no integrity binding. On a trusted home subnet that is the accepted model,
but any peer (or an ARP/mDNS spoofer) could substitute the payload. The safer
form is to download first, read it, then run it:

```
irm <base>/client/pi/install.ps1 -OutFile pi-stargate-sync.ps1
# read pi-stargate-sync.ps1
./pi-stargate-sync.ps1
```

Re-running the one-liner is the supported way to re-sync.

## Reading the reports

**Fleet → Client sync · Pi setup reports** lists recent reports from each
client: the stage, whether it succeeded, the error code if not, and a short
redacted message. Reports are display-only. They are never a control surface, a
routing input, or an admission signal, and silence is never an instruction.

A report carries only: the sync stage, a pass/fail, an error code and a short
message, the client OS and PowerShell version, the Pi version if installed, the
base URL, a duration, and a per-stage breakdown. It never carries prompts, task
text, tool names, arguments or output.

Free-text fields are redacted before they are stored: Windows user paths become
`C:\Users\<user>`, URL userinfo is stripped, `Bearer` fragments are removed, and
this gateway's own hostnames are replaced with `<host>`. A report that tries to
set its own `at` or `report_id`, carries a credential-shaped field, or exceeds
the size limits is rejected outright rather than sanitized and stored.

Reports are stored on disk beside the affinity state and survive a restart.
Retention is bounded by both an entry count and a byte budget, oldest first.

## Restoring a previous client file

The script leaves a timestamped backup next to the file it changed:

```
%USERPROFILE%\.pi\agent\models.json.<yyyyMMddTHHmmssZ>.bak
```

To undo a sync, close any running Pi process, then copy the desired `.bak` over
`models.json`. Nothing on the Star Gate side needs to change; the next sync
simply rewrites `providers[dsg-pool]`.

## Known limitations

- **A report needs a reachable Gateway.** If Star Gate is down, or the
  Continuity Door is holding POSTs during a core replacement, the script cannot
  deliver its report. It prints a clear local error and exits non-zero instead.
- **No integrity binding.** See the note above; use download-then-run where the
  network is not fully trusted.
- **Windows only.** The script is PowerShell; there is no macOS or Linux
  equivalent on this route.

## Manual acceptance checklist (Windows)

CI is macOS/Linux, so this is a written checklist, not an automated gate. Report
it as executed or not executed; it is not the merge gate.

1. Fresh machine with no `models.json`: run the one-liner; confirm the file is
   created with only `dsg-pool`, that `compat.chatTemplateKwargs` is an object,
   and that Star Gate shows a success report.
2. Existing `models.json` with another provider: run it; confirm the other
   provider is semantically identical (re-parse both and deep-compare) and that
   only `dsg-pool` changed.
3. Re-run with no Star Gate change: confirm an identical file and a success
   report.
4. Star Gate reachable but returning a malformed bundle: confirm a `parse`
   failure report appears in the dashboard.
5. Star Gate stopped or the port blocked: confirm a non-zero exit and a clear
   local message, with no server-side report.
6. Preferred `.local` URL does not resolve: confirm the script falls back to the
   numeric IP URL and succeeds.
7. A Windows user path in an error message is redacted in the stored report.
