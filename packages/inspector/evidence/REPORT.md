# Inspector implementation and validation

Package ownership was limited to packages/inspector. Root manifests, the lockfile and the original application checkout were not edited. No commit or external publication was made.

Implemented a Vue 3/Vite inspector using the shared core Json contract and a typed Sim endpoint client. It reads authenticated engine state, refreshes through named SSE events, handles reconnects and exposes real Sim controls for personas, client messages, interactive replies, reactions, clock, faults, template review, snapshots and webhook delivery. Business view is read-only. Local media requests reject external URLs and redirects; the authentication form refuses production-looking and non-synthetic tokens. All UI, accessibility labels, errors and date formatting are English.

Flow rendering uses pinned MIT Flowso 0.1.0 FlowScreen with the server's renderedScreen projection. Input changes send visible fields to Sim fill, visible component actions send to Sim submit and back sends to Sim back. Vue reactive state is converted to a JSON projection before rendering; no separate browser runtime, crypto or endpoint client exists. Native JSON preview is read-only, and unsupported capabilities remain explicit.

## Automated checks

- pnpm check: passed.
- pnpm test: 34 tests passed in the coordinator's final release check, including 3 inspector security tests.
- pnpm build: passed; embedded inspector copied to dist/inspector.
- pnpm test:python: 2 Python SDK tests passed.
- pnpm --filter @wa-fake/inspector check: passed.

The initial concurrent test run found a Kapso media-auth mismatch outside inspector ownership. The coordinator corrected it; the full later test run passed.

## Live browser verification

Used the Orca embedded browser against the actual retained local runtime at 127.0.0.1:58991. DOM input events and browser clicks exercised the Vue handlers, not direct API substitutes. Verified client text send, incoming signed-webhook application response, interactive button tap, Flow open, fields saved through Flowso input events, encrypted submission to a review screen, terminal Flow completion and application acknowledgement after nfm_reply. Also verified list open and row selection produce a new client list reply and application text response. Recent message contents are omitted from this report.

Responsive checks at 390 x 844: document width 390; chat visible as a single column; sidebar hidden after selecting a persona; send button bottom 816.5 within viewport height 844. Full-screen Flow dialog width was 390 without document overflow. Desktop verification used a 1705px viewport. Screenshot capture works after bringing the Orca window forward; early captures timed out while another workspace surface held focus.

Final English captures: desktop.png, mobile.png, flow-form.png and flow-complete.png. Desktop and Flow PNGs use a 1705 x 1125 viewport at 2x pixel density; mobile uses 390 x 844 at 1x density. All final screenshots use the refreshed English application demo with Ana and Bruno personas. Repeated the complete English Flow journey, including Back from review to the form, preservation of field values, resubmission and terminal completion. Final visible DOM was checked for Portuguese text and found none. An earlier fresh persona and English template also verified UI persona creation, template approval, quick-reply tap and clock advance through public APIs; these validation fixtures were removed by the coordinated runtime refresh.

## Fidelity and remaining scope

See ../README.md for the exact UI support and gaps. Supplier markdown/link previews, template media headers/carousels and custom Graph-token media downloads are not fully implemented. External links and supplier assets are omitted. The evidence panel honestly labels events as recent engine evidence because exact message correlation depends on recorded IDs. Snapshots contain synthetic content by design, while evidence panels redact content and credentials.
