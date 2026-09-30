# Core, Graph, webhooks and server integration

This report describes `packages/core`, `packages/graph`, `packages/webhooks`, `packages/server`, and the wire schemas. The SDKs, inspector, templates and Flows compose with this shared implementation. See the root verification report for final release evidence.

## Public integration API

- `WaEngine` implements the shared `EngineHost`. The shared `EngineStore` pins records for users, phones, media, templates, flows, sessions and arrays for messages, webhooks and redacted logs. Internal state adds WABAs, window timestamps, subscriptions and fault rules.
- Core methods: `user(waId, persona)`, `sendMessage(wire, phoneId?, path?)`, `receiveMessage(waId, wire, phoneId?)`, `advance(ms | duration)`, `state()`, `snapshot()`, `restore(snapshot)`, `reset()`, `configure(config)`, `addFault(rule)`, `drain({advance?, limit?})`, `redeliver(id)`, `uploadMedia(bytes, mime, filename, phoneId?)`, `mediaUrl(id, baseUrl)`, `onEvent(listener)`.
- `createWaFake(options)` is async and returns `{engine, app, baseUrl, url, graphToken, simToken, user, close}`. `port: 0` selects an ephemeral port; defaults are HTTP 58991 and HTTPS 58990. HTTPS accepts `cert`/`key` filesystem paths. `close()` terminates HTTP keepalive and SSE connections.
- `createApp(engine, {inspectorDir?})` creates the Hono app without a listener. Composition registers `createTemplates(engine)` and `createFlows(engine)` through their package exports. Both receive the existing contract without method changes.
- Inspector assets resolve from the source `packages/inspector/dist` layout and the bundled `dist/inspector` layout, including execution from another working directory.

## Implemented behavior

Strict schemas cover outbound text, image, audio, video, document, sticker, location, contacts, reactions, reply buttons, lists, CTA URLs, Flow messages, read receipts and typing. Template component and Flow semantic validation is delegated to their real extensions. Unsupported message/interactive capabilities return Graph errors with HTTP 501.

Auth separates Graph and Sim credentials, refuses EAA tokens, checks messaging/management scopes, phone access and WABA ownership before extension dispatch. Only loopback listeners, callback URLs, endpoint URLs and download URLs are accepted. Browser cross-origin requests and foreign Host headers are refused. Network requests do not follow redirects.

Synthetic personas open independent 24-hour windows per phone/user pair. Read requests reference inbound messages and typing expires after 25 virtual seconds. Outgoing statuses run at virtual +0/+1/+2 seconds, or produce `failed` through status fault injection. Queue payloads have real WABA entry/change envelopes; callbacks receive HMAC-SHA256 over persisted UTF-8 raw bytes. Retries use deterministic exponential backoff with a seven-day cutoff and configurable maximum attempts. An active drain is reentrant-safe when an application sends a Graph reply while processing a callback. Sim drain defaults to advancing the virtual clock until queued work completes, with a 1000-event processing bound.

Media upload validates allowed MIME declarations and size, computes SHA256, persists bytes in snapshots, and exposes five-minute HMAC-signed downloads requiring Graph Bearer auth. Explicit MIME is authoritative when a multipart client supplies the generic octet-stream header; contradictory concrete headers are rejected. Inbound media envelopes add MIME/SHA256 metadata. Stored canonical reply contexts become `context.id/from` in callback envelopes.

Faults support `phase: graph | status | webhook`, optional `match: {path, to, type}`, positive `times` and `error: {code, status?, error_subcode?}`. Unknown fault options are refused. HTTP evidence keeps allowed routing/status identifiers, never request bodies, credentials, callback response bodies or message contents. Authenticated state and snapshots intentionally expose synthetic message/session content.

Basic Graph management covers WABA fields, phone listing/details, registration/deregistration, fixed synthetic verification code, business profile, subscribed apps with local handshake, and debug-token information. Unknown Graph routes, fields and capabilities return 501 without falling back to inspector HTML.

CLI `certs` uses OpenSSL to generate a local CA and server certificate with critical CA constraints/key usage, SAN, EKU, SKI and AKI. Certificate directory permissions are 0700 and private keys are 0600. The HTTPS test checks `openssl verify -x509_strict` and makes a CA-trusted HTTPS request.

## Fidelity gaps for the documentation owner

- This is local synthetic behavior. Passing local fixture or client tests does not establish supplier conformance across Graph versions; all accepted `vN.0` routes share the same implementation.
- Status timing, pricing/conversation metadata, throughput and the fixed verification code are approximations. Default throughput is 80 messages per virtual second; pair limiting is opt-in through `pairRateLimitMs`.
- Upload MIME and byte size are validated, but binary image/audio/video structure, codecs, animated sticker detection and document safety are not inspected. Sticker limit is 500 KiB; the separate static-sticker limit is not detected.
- Sending media by URL returns explicit 501 after enforcing loopback; the implemented path is upload then media ID. No external media is fetched.
- Incoming referral/order/system/unsupported/edit/delete shapes, commerce, calling, resumable profile uploads, analytic/billing endpoints, batching, duplicate/out-of-order delivery, invalid-signature injection and latency faults are not implemented. Unsupported capabilities fail explicitly.
- With no callback configured, generated envelopes remain `unconfigured`; explicit redelivery is required after configuring a callback. Existing unconfigured history is not silently delivered.
- State is in memory. Reset retains the monotonically increasing message ID counter while resetting data and clock; snapshots deliberately restore the captured counter/namespace for replay. Config credentials remain instance-local and are not imported through snapshots.
- Log evidence does not contain full Graph request/response bodies; synthetic contents are available through the authenticated inspector state/snapshot surfaces.
- Kapso media download requires its public `auth: "always"` option for a local origin; its default auto mode sends credentials only to kapso.ai. Server download authentication remains strict.

## Dependencies and validation

Package manifests use only the already-approved root dependencies: core `ajv`, graph `hono`, server `hono` and `@hono/node-server`; crypto, DNS, filesystem, HTTP/HTTPS, OpenSSL invocation and stream support use Node built-ins. The coordinator owns any workspace lockfile updates.

Meaningful tests cover HTTP auth/scopes/WABA access, window boundary, read/typing, graph/status/webhook failures, byte-level HMAC, retry timing, every basic wire send type, real media/location/contact/reply envelopes, invalid payloads and unsupported capabilities, signed media expiry/auth/hash/snapshot/delete, snapshot replay and endpoint rejection, monotonic reset IDs, SSE, loopback/Host checks, redirect refusal, management endpoints, and strict trusted HTTPS.

Final validation passed: `pnpm check`, `pnpm test` (34 tests across eight files, including domain/inspector and independent client/fixture/journey coverage), `pnpm build`, and `pnpm test:python` (two tests). Core contributes four tests and server contributes eight HTTP integration tests. The coordinator independently confirmed the existing Quites HTTPS adapter contract without modifying that checkout. Supplier behavior beyond these local contracts remains unverified.
