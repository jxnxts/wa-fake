# wa-fake

Read README.md, docs/assumptions.md, docs/architecture.md and docs/contracts.md before editing.
This is an independent local simulator. Do not edit another project's checkout.
Only synthetic data. Never proxy to Graph/Meta. Refuse production-looking EAA tokens.
Callbacks, Flow endpoints and downloads remain loopback-only. The repository is public under MIT; registry publication is a separate release task.
Unknown/unsupported capabilities must return explicit 501, never fabricated success.
Log/evidence must redact tokens, secrets and message contents; synthetic state is available through the authenticated inspector state endpoint.
Shared checkout: edit only your assigned packages and report integration changes to the coordinator.
Run pnpm check, pnpm test, pnpm build and Python SDK tests for the completed product.
Keep docs/fidelity.md honest about approximations and untested supplier conformance.
All UI, documentation, examples, comments and authored fixtures must be in English.
