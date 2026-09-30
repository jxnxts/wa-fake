# Plan review

The Graph/Sim/Inspector separation and explicit clock are sound: applications use production wire contracts while tests control users/events separately.

Planning corrections:

- Complete/Meta-identical are goals, not initial status. Supported capabilities require evidence; unsupported behavior returns 501.
- Phase estimates total roughly eleven weeks while the narrative rounds to ten; agent execution does not make that a delivery guarantee.
- Seeded determinism and cross-restart uniqueness need instance namespaces/counters.
- Inspector and SDKs must share the engine rather than creating a separate browser runtime.
- Network rules apply to callbacks/Flow endpoints/redirects as well as Graph proxying.
- Snapshots carry synthetic data; evidence redaction and Sim authentication are distinct contracts.
- Flowso exports/licenses must be verified; the pinned package supplies validator/runtime/crypto/Vue exports.
- Full application E2E can depend on database, identity and workflows; a transport test is narrower than that application journey or provider homologation.

Decisions: wa-fake, independent English MIT repository, read-only business view, calling/commerce outside v1. The current official Postman source contains 169 response examples; ten curated fixtures are recorded. Cataloging all examples does not mean they are all implemented/tested.

See [tasks](tasks.md), [architecture](architecture.md), [fidelity](fidelity.md).
