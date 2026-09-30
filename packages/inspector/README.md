# wa-fake inspector

Vue 3/Vite inspector embedded from `dist` by the local server. No separate engine or demo state: all conversations come from authenticated `GET /_wa/state` and mutate through the documented Sim endpoints. `pnpm --filter @wa-fake/inspector dev` opens loopback port 5173 with a proxy to the server at 58991; `build` runs Vue typechecking and emits `dist`.

## Implemented

- Permanent synthetic/local banner, responsive persona list/search/create, business-number selection, client/company views (company is read-only), light/dark themes and keyboard labels.
- Text, local media metadata/download/preview, offline location illustration, contacts, reactions, quoted replies, resolved templates, interactive buttons/lists/Flow calls and explicit fallback for unrendered message types.
- Client text/media-ID/location/contact composer through Sim; company messages originate from the application using Graph. Existing media can be injected by ID; upload is an application Graph operation.
- Clock +1h/+24h, error-code fault injection, template approve/reject, snapshot download/restore/reset, webhook queue drain/redelivery, and selected message metadata plus redacted recent Graph/Sim/webhook evidence.
- Flowso 0.1.0 Vue FlowScreen when the server supplies `session.render`/`renderedScreen`. Inputs are debounced into Sim fill; footer actions use Sim submit; back uses Sim back. No browser endpoint/crypto/runtime implementation. Native read-only Flow JSON preview and basic native fallback.
- Sim Bearer default `wa-fake-sim` held in memory; optional synthetic token persisted in sessionStorage. Form refuses EAA and non-wa-fake credentials. EventSource uses documented query-token auth; named domain/core events trigger fresh state; disconnected SSE falls back to 5s refresh.

## Limitations and fidelity

This UI is a local approximation, not supplier conformance. No logos, external map tiles, external media fetches, external links or publishing. Local media loading uses the synthetic Graph default `wa-fake-token`; custom Graph-token instances must use their API client to download media. A snapshot intentionally includes synthetic message content; evidence panels redact content/credentials again in the browser.

Text is displayed as escaped plain text (supplier markdown/link previews are not implemented). Template media headers and carousel cards are not fully rendered; unsupported wire types remain visible in JSON fallback. Template URL/telephone/OTP actions are displayed without contacting external services. Template quick replies and Flow controls call the motor.

FlowScreen receives server-rendered values, validation and conditional visibility. Visible component actions are forwarded to Sim submit with current visible fields; the server validates action ownership and returns explicit errors for unsupported actions. Component images accept embedded PNG/JPEG/WebP/GIF data only. Native fallback resolves simple data/form bindings but is not a replacement for the server Flowso renderer; unsupported components disable native submission. Preview is read-only and renders the first JSON screen without endpoint data exchange.

All interface text, accessibility labels, errors and date/time formatting are English. Conversation contents and Flow copy are supplied by the connected synthetic application and are not translated by the inspector. This package is part of the repository's MIT-licensed open source project; Flowso is an MIT-licensed pinned dependency, and no supplier assets are copied.

Recent evidence is labeled as recent motor evidence rather than claiming message-level correlation that the server has not recorded. Signature verification and delivery success are shown only when present in engine records. Typing reflects the phone's simulated typing deadline and expires with the simulated clock. Status ticks show engine status, never an optimistic fabricated delivery.
