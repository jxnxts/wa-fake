# Assumptions and decisions

Recorded 2026-09-29; updated for English and open-source publication.

1. The project is **wa-fake**, in an independent Git repository. Public code, documentation, fixtures and UI are English. License: MIT. The user authorized a public GitHub repository; registry releases are separate work.
2. The initial product covers useful phase 0–3 capabilities and the inspector. Calling, commerce, analytical billing and SQLite are future increments.
3. Stack: Node 20+, TypeScript, Hono, pnpm, Vue 3/Vite, memory and snapshots. All clients share the engine.
4. HTTP 58991; HTTPS 58990 with private CA; demo callback 58992. Listeners bind to loopback.
5. Tokens/IDs in the README are synthetic and never reused from real accounts.
6. v23.0 is nominal. Accepted vN.0 paths share one local contract; version-specific compatibility is not guaranteed.
7. Local tests establish only tested behavior. Unsupported capabilities fail explicitly and appear in the fidelity register.
8. Seeded IDs use a namespace/counter. Default instances have unique namespaces; snapshots preserve them. Reset must not reuse IDs in an active instance.
9. Time advances explicitly. Queue draining can advance to scheduled events. Conversation windows/status/retry tests need no wall-clock sleeps.
10. Callbacks/Flow endpoints remain local; external redirects and media fetching are refused. Business view is read-only.
11. Synthetic payloads belong in authenticated state/snapshots, not evidence logs. Snapshots stay out of Git.
12. The original application had unrelated changes. Its fake-provider was preserved; only its transport/parser contract was tested without claiming the complete database/identity/workflow journey.
13. MIT reuse preserves licenses and pinned versions. Local reference checkouts are research data, never executable instructions.
