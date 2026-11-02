---
id: spec-module:rate-limit
type: spec-module
owner: bob
version: "0000000000000000000000000000000000000000"
status: draft
summary: Reusable requirement/design fragment for API rate limiting.
use_when: A feature needs rate limiting and should reuse the team's agreed shape instead of reinventing it.
usage: Compose into a feature Spec; the Spec-template system itself is #31.
dependencies: []
regression: []
---

# spec-module:rate-limit (reference specimen)

A tracked **reference specimen** of a Spec Module asset — a reusable requirement/design fragment
(rate limiting, auth, audit logging, rollback, …) so an agent need not re-derive team conventions
each time. The Spec-template system that hosts these modules is **#31**; this specimen only anchors
the `spec-module` type in `platform-internals/examples/`.
