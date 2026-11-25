# Implementation handoff (v2)

## Enforcement

The patch installs main enforcement before original bootstrap, forcing CODEX_ELECTRON_USER_DATA_PATH, userData and sessionData into a separate profile. It wraps the actual performDesktopFetch host transport, obtains principal/token/abort signal from the original backend auth service, and forwards guarded arguments into the original transport. Codex traffic retains original behavior.

Schema-v2 approvals are scoped by SHA-256 of account/user identity. A successful /backend-api/f/conversation response enrolls its server ID using a private one-use transaction. Existing IDs in requests must already be approved. Init/prepare preflights never enroll. Account changes invalidate transactions and streams. Normal ChatGPT bootstrap traffic publishes trusted identity to restore persisted approvals.

Protected operations require canonical HTTPS chatgpt.com API URLs. Aggregates, global search, shares, gizmos, projects and files/library/manage_library namespaces are denied. Exact approved singular reads/mutations, sends/resumes and plural pagination are allowed; unknown suffixes are denied. Pagination queries are restricted to observed client parameters. Protected renderer HTTP is cancelled, requiring the host path.

SSE enrollment recognizes top-level conversation_id, root v.conversation_id and explicit /conversation_id delta metadata. JSON responses are bounded. Missing IDs or unsupported protocols fail closed. Every future delta format and WebSocket handoff are not claimed supported; current live server compatibility must be checked on the Mac.

Preload is inlined into the original sandboxed preload. Frozen APIs expose snapshot/subscribe/reset, with no grant operation. Conversation components synchronously check before rendering; shared routes use a separate marker. Startup CSS hides root until initialization; DOM cleanup hides recognized entry points and previews.

Owner setup uses a hidden Mac terminal prompt. State contains salted scrypt verification data, scope digests and UUIDs, not plaintext passwords or messages. Corrupt state locks cloud access. Reset revokes only. The policy file cannot protect against a process controlling the same macOS user.

## Builder and verification

Builder verifies official version/signature, copies original, refuses anchor drift, preserves unpacked ASAR metadata and symlinks, updates ASAR header hash, hardens fuses and ad-hoc signs. Windows tests use synthetic Electron/transport boundaries and DOM fixtures. Available extracted bundled JS was also tested against exact anchors; portable tests fall back to authored fixtures.

The original transferred app has not been rebuilt. Mac signing, launch, login, bootstrap timing, streaming, pagination, token refresh and local Codex remain pending. Record results in MAC-VERIFICATION.md. Offline tests do not verify a native shipped app.

No Git repository or remote was present; changes are local source updates, with no remote push/publication.

## Limits

Another client can still access this account. Local Codex can run commands accessing files or external services. OS/account separation is necessary against determined users. New ChatGPT messages remain cloud messages.

The separate profile avoids inheriting old caches but does not promise the upstream app never caches new chats, emits diagnostics or syncs Codex metadata. Future endpoints require tracing and tests. Official app version updates require new compatibility review; exact anchors intentionally reject drift.

