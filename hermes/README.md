# Gate Genie profile

`SOUL.md` here is the first-run default. The dashboard seeds it only if the
owner's file does not exist. It never resets an existing file, even an empty one.

The editable copy lives at `<directory of state_file>/hermes-home/SOUL.md`.
`ds4-gateway/hermes-profile.mjs` exports `hermesHome(config)` as the shared
profile location. The native Hermes launcher must set `HERMES_HOME`
to that directory; it must not replace OS `HOME` or restrict local access.
The owner installation runs the native fork via its generated launcher,
`.hermes/bin/hermes --run-module gateway.run`, under the launchd service
`local.star-gate.hermes`. Dependencies are managed by the fork's native
`setup-hermes.sh --runtime-only`, with a separate `HERMES_RUNTIME_DIR`
under this profile. No alternate agent loop or tool proxy is used.

The dashboard's Soul tab reads and saves that exact file. Each changed save
backs up the previous content under `hermes-home/soul-history/`, then replaces
SOUL atomically. A loaded revision detects stale browser drafts; this is edit
conflict detection, never a runtime hash requirement or startup permission gate.
To restore a previous version, copy its text into the editor and save.

Saving does not restart Hermes or rebuild a live conversation's cached prompt.
Native Hermes reads SOUL when building session context; start a new session to
use the saved text. SOUL is one part of the native prompt, alongside Hermes'
own prompts, tools, skills, memory, and applicable context files. This feature
does not modify those or claim to grant OS permissions through prompt text.

The owner profile uses the existing local PoolModel endpoint and Telegram bot.
Credentials are in the private profile `.env`; they are never shipped in Git.
The owner explicitly approved native `approvals.mode: off` and
`security.protected_instruction_files: false`. Those are this owner's choices,
not settings imposed on other installations. Telegram is restricted to the
existing paired owner account. Use native Hermes setup for another installation.

## Memory viewer

SGUI's Memory tab reads this profile's `memories/MEMORY.md`, `memories/USER.md`
and Markdown files under `skills/`. It shows the native files, including missing
or empty memory, and has a searchable, collapsed file list. It does not maintain
a second store, edit the files, poll the model, or generate summaries. Saved files
can differ from the frozen memory snapshot in an existing conversation.

## Gateway inference priority

Star Gate schedules identified Genie requests ahead of other waiting requests,
including ordinary high-priority work. Existing generations finish normally;
conversation order, model compatibility, request bodies, limits and capacities
are preserved. Unaffined Genie calls can use the next compatible free worker.
Sustained Genie traffic can delay ordinary queued traffic; active work is never
preempted. This is scheduling, not a fleet-management permission.

Set `genie_priority_key` in your private gateway configuration and use the same
value in the native Hermes profile's route-specific headers:

```yaml
custom_providers:
  - name: Star Gate
    base_url: http://127.0.0.1:30000/v1
    extra_headers:
      x-stargate-genie-key: YOUR_PRIVATE_MATCHING_VALUE
```

Merge into an existing matching provider entry instead of replacing its other
settings. Keep the value out of Git. Existing gateway/API authorization remains
unchanged. The scheduling header is stripped before forwarding to model servers;
requests without a matching value keep their normal priority. Other model
endpoints do not receive the route-specific header.

A fresh native client reads these headers. An already-created Telegram client
may need an idle reload; configuring the file is not proof that an existing
conversation is sending them. Inspect Current Jobs for `priority_policy: genie`
(or its “Genie · next slot” UI label) on an actual request before claiming that
conversation has priority. Never interrupt a working turn to force activation.
