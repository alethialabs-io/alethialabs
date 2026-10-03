// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Which clusters the kubeconfig mint can serve at all — which clouds, which placements — and the
// sentence for a shared cluster (#5322, #5327).
//
// WHY THIS IS NOT UNDER lib/kubeconfig-mint/. That directory is on the AI tool-scope denylist
// (lib/ai/tools/registry.ts AI_TOOL_DENIED_MODULES): no agent entry point may reach it, and the
// console's cluster read — which an AI tool does reach — must say whether a cluster can be minted
// for. These are pure facts with no I/O; they issue nothing and request nothing. The mint machinery
// (lib/kubeconfig-mint/request.ts, clouds.ts) imports them from here, so there is still one list.

import type { CloudProvider } from "@/lib/db/schema/enums";

/** The five clouds the MINT_KUBECONFIG job serves. DigitalOcean and Civo have no minter. */
export const MINTABLE_CLOUDS: ReadonlySet<CloudProvider> = new Set([
	"aws",
	"gcp",
	"azure",
	"alibaba",
	"hetzner",
]);

/** {@link MINTABLE_CLOUDS} read by a plain string, for callers holding an unnarrowed provider name. */
const MINTABLE_NAMES: ReadonlySet<string> = MINTABLE_CLOUDS;

/** Whether the MINT_KUBECONFIG job serves `provider` at all (in some shape). */
export function isMintableCloud(provider: string | null): boolean {
	return provider !== null && MINTABLE_NAMES.has(provider);
}

/**
 * Why a namespace/vcluster environment gets no kubeconfig. The runner sends it (#5283); the request
 * route answers it as a 422 before any job exists (#5327); the cluster card and `alethia cluster get`
 * print it in place of a command (#5322) — so all three say the same sentence.
 *
 * It is ALSO a literal in KUBECONFIG_MINT_FAILURE_REASONS (lib/kubeconfig-mint/reasons.ts), because
 * the runner's parity test reads that list as literals only. tests/kubeconfig-mint/vocabulary.test.ts
 * fails if the two copies ever differ.
 */
export const KUBECONFIG_MINT_SHARED_CLUSTER_REASON =
	"Kubeconfig mints are not available for an environment placed on a shared cluster.";

/**
 * Whether a placement mode puts the environment on a SHARED cluster (`namespace` or `vcluster`).
 * Such an environment's cluster row names the shared Fabric's host cluster, so a mint for it would
 * hand one tenant the whole cluster: the request route refuses it, the runner refuses it again, and
 * the kubeconfig surfaces print no command for it. Takes `unknown` because one caller reads the
 * value out of a config snapshot's JSON.
 */
export function isSharedClusterPlacement(mode: unknown): boolean {
	return mode === "namespace" || mode === "vcluster";
}
