---
schemaVersion: 1
predicate: B7
cloud: all
date: "2026-11-23T16:06:43Z"
buildSha: "a03ee4d5daa4bb6f26b1938dce109a67b70936ff"
verdict: pass
instrument: scripts/ops/restore-drill.sh
observer: agent
check: restore-drill
tombstonesReplayed: true
durationSeconds: 172
evidence:
  - docs/beta/evidence/b7/2026-11-23-restore-drill.log
  - scripts/ops/restore-drill.sh
  - docs/ops/restore-runbook.md
---

# B7 restore drill — 2026-11-23

- Backup restored: daily `20261123T144753Z` (manifest finishedAt 2026-11-23T14:47:59Z)
- Console image: `a03ee4d5daa4bb6f26b1938dce109a67b70936ff`
- Tables restored from the dump: 149
- Newest tombstone export merged: 2026-11-23T16:04:48Z
- Tombstone replay: `{"mode":"apply","tombstones":0,"replayed":0,"nothingToReplay":0,"rowsErased":0,"rowsPseudonymized":0,"remaining":0}`
- Readiness body: `{"status":"healthy","mode":"readiness","ts":"2026-11-23T16:06:43.451Z"}`
- Clock: started 2026-11-23T16:03:51Z, serving 2026-11-23T16:06:43Z (clock started by --started-at, before the script)
- Outcome: restored, replayed and serving in 172s

Steps, in order, are in [`2026-11-23-restore-drill.log`](2026-11-23-restore-drill.log). Commit both files.
