# Project plan

Adapted from the 29 September 2026 research plan. This English plan describes the delivered first release and keeps the broader roadmap explicit. Implementation status and evidence live in [tasks](tasks.md), [fidelity](fidelity.md) and [verification](verification.md).

## Problem and product

Applications integrating with WhatsApp repeatedly build permissive message mocks, webhook helpers and encrypted Flow test clients. These separate tools miss validation, delivery failures and shared conversation state.

wa-fake provides one local synthetic server with three surfaces: a Graph-shaped API for application code, an authenticated Sim API for test controls, and an inspector for virtual users. The application changes its API origin and trusted local CA. A virtual user can send text, select buttons and lists, fill a Flow, and receive the application's signed-webhook response.

The first release covers complete selected journeys across messages, templates and encrypted Flows. It does not claim complete Cloud API compatibility. Unsupported capabilities fail explicitly and the public fidelity register identifies approximations.

## Decisions

- Independent repository and MIT license; English documentation, UI, examples and authored fixtures.
- TypeScript on Node 20+, pnpm workspace, Hono HTTP routes and Ajv wire schemas.
- Vue 3/Vite inspector embeds the pinned flowso 0.1.0 renderer. The server owns runtime state and endpoint crypto.
- In-memory state, virtual clock, seeded IDs and snapshots; no database for the first release.
- Loopback listeners and endpoints, separate Graph/Sim credentials, synthetic defaults and no remote API forwarding.
- Python SDK and pytest fixture communicate with the same HTTP server. External clients remain unmodified.
- Source publication on GitHub now; npm, PyPI and container registry releases require separate packaging work.

## Architecture and task sequence

1. **Foundation:** define shared contracts, errors, auth, network boundaries, clock and state; compose HTTP/HTTPS and certificate CLI.
2. **Messaging:** validate wire payloads, implement media lifecycle, signed webhook queue, status timeline, windows, faults and Sim controls.
3. **Parallel domain work:** implement template validation/review/rendering and Flow management/encrypted sessions against the same engine contract.
4. **Inspector:** build personas, conversations, interactive replies, Flow rendering, evidence and state controls; verify responsive behavior in a browser.
5. **Integration:** add JavaScript/Python clients, a real local application callback/Flow endpoint, official fixture shapes and an external SDK contract.
6. **Release verification:** run type checks, automated journeys, verified HTTPS, container smoke test and browser checks; document gaps before public source publication.

Work was assigned to three specialized agents for core/Graph/webhooks/server, templates/Flows, and inspector. The coordinator owned contracts, SDKs, examples, fixtures, build/runtime, integration verification and release documentation. Shared files and package installation remained with the coordinator; each worker had a defined directory boundary.

## Acceptance evidence

The delivery must demonstrate a real HTTP application journey: text → signed webhook → buttons → list → encrypted Flow INIT/exchange → nfm_reply → application acknowledgement. It must also demonstrate invalid credential rejection, the 24-hour window, template parameter errors, media bytes/hash/expiry, retry/backoff, snapshot replay, strict local CA trust and explicit unsupported responses.

Template and Flow tests include positional/named parameters, manual review transitions, multipart assets, publish health, independent official crypto, RSA key refresh on 421, 427/432 handling, malformed endpoint responses and a real ten-second timeout. Local contracts are not supplier certification.

## Roadmap beyond this release

| Area                  | Remaining work                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Supplier conformance  | Expand the official case corpus, compare twenty template-error cases, run the complete official endpoint examples and separately authorized live recordings. |
| Client coverage       | Add another independent Python Cloud API client and additional SDK versions.                                                                                 |
| Application migration | Validate a complete authenticated application journey before replacing an existing application's own simulator.                                              |
| Advanced webhooks     | Duplicate/out-of-order delivery, batching, invalid-signature and latency injection; additional event families.                                               |
| Flows                 | Picker/navigation components, metrics/migration and remote BLOCKED/THROTTLED policies; periodic health scheduling.                                           |
| Commerce and calling  | Product/catalog messages, commerce settings, calling, QR codes and advanced account administration.                                                          |
| Inspector             | Rich supplier formatting, link previews, template media/carousels and more exact event correlation.                                                          |
| Distribution          | Standalone npm CLI/SDK packaging, installable PyPI distribution, versioned container image and install-from-release CI.                                      |

These items require their own acceptance tests and fidelity entries. A successful core journey does not close the entire roadmap.
