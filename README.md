# ChatGPT History Guard v2 (macOS Source Prototype)

**Status:** Unverified macOS Prototype (Windows offline tests passed; macOS native build, signing, and live acceptance checks pending)

Personal hardening patch for Apple silicon ChatGPT/Codex **26.930.61225**, macOS 13+. This replaces the renderer-only prototype with main-process policy and authenticated transport checks. The transferred compiled app is still the old prototype; rebuild on a Mac to install these changes.

## Changes

- Main-owned, account-scoped approvals. Renderer localStorage cannot grant access; old approvals are not imported.
- New chats become approved only after an authenticated creation response returns a valid conversation ID. Clicks, timers, routes and preflight responses cannot enroll IDs.
- Blocks old-chat reads/mutations, cloud search, shared chats, projects, custom-GPT listings and file-library views. Exact approved-chat reads and pagination remain permitted.
- Separate profile, locked startup, sandbox-compatible preload, synchronous route checks and preview cleanup.
- Salted scrypt owner password; reset revokes every approval and cannot unlock older chats. Failed password attempts are throttled.
- Restricted developer tools, inspector flags and account-chat navigation. Builder enables ASAR integrity and ASAR-only loading.
- Local Codex routes and transport preserved; live Mac verification remains pending.

New ChatGPT chats still use OpenAI's servers. This is not local inference. A user with the account credentials, another client, control of the macOS account or unrestricted Codex commands can bypass app-level restrictions. Separate accounts and a separate non-admin macOS user provide stronger separation.

## Build on the Mac

Use Node.js 22+ and the official app at the exact supported version. The builder refuses modified input bundles, other versions and existing output paths.

```sh
cd HistoryGuardSource
npm ci --ignore-scripts
npm test
npm run check
npm run build -- '/Applications/ChatGPT.app' '/tmp/ChatGPT History Guard v2.app'
```

The original is copied, not edited. The copy is ad-hoc signed, not notarized. Move the verified output to Applications using Finder; Gatekeeper may require Control-click → Open. Build outside cloud-managed folders.

With the app quit, configure the owner password before first launch:

```sh
npm run owner -- setup
```

Enter at least 12 characters in the hidden terminal prompt. Later, quit the app and run `npm run owner -- reset` to revoke all approvals. Passwords are not accepted as command arguments.

The separate profile is `~/Library/Application Support/ChatGPT History Guard v2`. It starts empty and requires fresh login. Trusted account bootstrap restores saved approvals; unavailable identity keeps cloud chats locked. Aggregate history/search/library screens are restricted.

Read [MAC-VERIFICATION.md](MAC-VERIFICATION.md) before using a rebuild. No rebuilt app was launched or signed on the Windows host.

## Contents

`guard/policy.cjs` owns approvals and password checks; `main.cjs` enforces transport and Electron restrictions; `preload.cjs` exposes snapshots and revocation; `history-guard.js` and CSS protect rendering. `scripts/patch.mjs` has exact version-specific anchors; `build.mjs` rebuilds/signs the copy. Tests cover policy, transport, runtime, renderer, patch integration and owner operations.

Keep bundles, ASAR files, node_modules and account data out of public repositories. This handoff contains authored source and synthetic fixtures, not OpenAI's packaged app. See [HANDOFF.md](HANDOFF.md).

