# empty-asset-dir — planted problem: an asset scan with nothing to scan

This directory contains **no asset** — only this README, which `check-asset-metadata` skips by name.
Pointing the check here therefore validates zero files.

That is the planted problem. The other five fixtures each plant a *wrong fact* (a dangling reference,
a malformed version, a past expiry, a decayed case, an unguarded destructive command). This one plants
the **absence of any fact to check** — the failure mode where a workspace that deleted its assets
still reports green because nothing was left to disagree with.

It is the shape a real workspace takes on the way to being gutted: `platform-internals/examples/` emptied out during a
"cleanup", its README left behind. Before this fixture existed, that state produced
`OK: 0 example assets conform ...` and `ws test` passed.

| | |
|---|---|
| Class | vacuous green (zero coverage reported as a pass) |
| Detected by | `check-asset-metadata` — `checked == 0` is a FAIL, not an OK |
| Asserted in | `ws health --self-test`, detector 6 |

Nothing here is executed and nothing here is credential-shaped; like its siblings it is inert data
scanned by the self-test. Leaving this directory without assets is the point — adding one would
disarm the detector it exists to prove.
