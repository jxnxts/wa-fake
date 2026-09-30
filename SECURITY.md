# Security

This is a local synthetic test tool. Keep listeners/callbacks/Flow endpoints on loopback and use dedicated synthetic credentials/data. Requests are not forwarded to Meta.

Do not put real tokens/documents/bank data in the simulator. State/snapshots contain payloads even though evidence is redacted. Keep `.local` and snapshots out of version control.

Public issues should use minimal synthetic reproductions without secrets. Use GitHub private vulnerability reporting, if available, for issues involving private data or real credentials.
