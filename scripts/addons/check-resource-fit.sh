#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Fails when a catalogued add-on renders a POD whose memory request no default node can hold.
#
# WHY THIS EXISTS
#
# minio's chart defaults to `resources.requests.memory: 16Gi`. The catalog shipped that unexamined,
# and a cpx32 node is 16 GB in TOTAL — so after kubelet and system reserve there was no node in any
# default Alethia pool, on any cloud, that could hold the pod. It did not run slowly. It never
# scheduled:
#
#   Warning FailedScheduling  0/7 nodes are available:
#     1 node(s) had untolerated taint(s), 6 Insufficient memory.
#
# loki was the same story at one remove: its chunks-cache memcached sizes its request from
# `chunksCache.allocatedMemory`, whose chart default is 8192 MB, so that pod asked for 9830Mi and
# starved the node for everything else. Together they were 27 of the surface's 29.6 Gi.
#
# NOTHING ELSE COULD SEE IT. These are CONSTANTS, so the render never drifts and
# check-render-determinism agrees with itself. They are not credentials, so check-published-defaults
# has no opinion. ArgoCD reports the Application Degraded or Progressing, which reads like a slow
# chart — and the only place the truth appears is a FailedScheduling event on a cloud run that has
# already been paid for. This check costs a helm render and no cloud at all.
#
# THE CEILING IS PER POD, NOT PER SURFACE
#
# A surface total says how big a cluster must be; a single pod over the ceiling cannot schedule at
# ANY cluster size, which is a different and worse failure. The ceiling is deliberately generous —
# an add-on legitimately needing more than this is possible, which is what the ratchet is for.
#
# THE ALLOWLIST IS A RATCHET, both directions: an add-on over the ceiling that is not declared
# fails; a declared one now under it fails (remove the line, so the list only shrinks); a declared
# one that is no longer catalogued fails; and a render finding NO pods at all fails, because a sweep
# whose "found nothing" branch is indistinguishable from its "nothing is wrong" branch is the defect
# this repo keeps paying for.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$repo_root/test/e2e/fixtures/addon_catalog.json"
allowfile="$repo_root/scripts/addons/resource-fit-allowed.txt"

# 4Gi. Every cloud's default worker shape is at least 8 GB, so a single marketplace add-on asking
# for more than half of one is the thing worth a human decision.
ceiling_mi=4096

command -v helm >/dev/null 2>&1 || { echo "check-resource-fit: helm is not installed" >&2; exit 2; }
[ -r "$fixture" ] || { echo "check-resource-fit: no fixture at $fixture" >&2; exit 2; }
[ -r "$allowfile" ] || { echo "check-resource-fit: no allowlist at $allowfile" >&2; exit 2; }

node "$repo_root/scripts/addons/resource-fit.mjs" "$fixture" "$allowfile" "$ceiling_mi"
