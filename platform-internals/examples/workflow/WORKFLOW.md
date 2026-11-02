---
id: workflow:spec-to-acceptance
type: workflow
owner: alice
version: "0000000000000000000000000000000000000000"
status: draft
summary: End-to-end flow — structured spec to task breakdown to execute to test to acceptance.
use_when: Running a real requirement through the standard end-to-end pipeline.
usage: A production workflow lives as a suite contract in suites/<id>/ (see platform-internals/suites/README.md).
dependencies: []
regression: []
---

# workflow:spec-to-acceptance (reference specimen)

A tracked **reference specimen** of a Workflow asset. An end-to-end multi-step flow is a **suite
contract**: a real one lands in `suites/<id>/` with its `SUITE.md` + `run`/`test`, composing payload
by pointer. This specimen anchors the `workflow` type in `platform-internals/examples/`; it does not add a parallel
workflow directory (that would duplicate `suites/`).
