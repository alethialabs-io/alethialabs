// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The ONLY failure reasons a kubeconfig mint may carry (#5281; #5292 advisory 3).
//
// `kubeconfig_mint_requests.failure_reason` is persisted and returned to the client by the poll, and
// the runner is the party that writes it. A runner that put a cloud SDK's `err.Error()` there could
// park a presigned URL or a bearer token in a row a person reads back — the error string IS the
// leak. So the console never stores text the runner wrote. The result route matches the posted reason
// against this list EXACTLY, and anything else is replaced with UNKNOWN before it reaches the row or
// the job's `error_message`. That is enforced here rather than in the wire contract
// (`kubeconfigMintFailureReason` is a bounded string) so the runner can add a sentence by adding it
// here first, without a Go/TS contract change — and a sentence it sends before this file knows it
// degrades to UNKNOWN, never to the raw text.
//
// The runner (apps/runner/internal/agent/kubeconfig_mint*.go, #5283) must send these strings byte for
// byte. They are written for the person running `alethia cluster kubeconfig`: what happened, in the
// cluster's terms, with nothing from the cloud's own error.

/** The reason stored when the runner's text is not one of the fixed sentences below. */
export const KUBECONFIG_MINT_UNKNOWN_FAILURE =
	"The runner could not mint the credential.";

/** Every reason a failed mint may be stored and served with. */
export const KUBECONFIG_MINT_FAILURE_REASONS: readonly string[] = [
	KUBECONFIG_MINT_UNKNOWN_FAILURE,
	"The cluster was not found in the cloud account.",
	"The runner could not reach the cluster's API endpoint.",
	"The runner could not assume the cluster's cloud identity.",
	"The cloud refused to issue a credential for this cluster.",
	"The read-only identity could not be prepared in the cluster.",
	"This cloud cannot issue the requested kubeconfig shape.",
	"The runner could not seal the credential to the client key.",
	// A namespace/vcluster environment's cluster row names the SHARED Fabric cluster; the runner
	// refuses to mint the whole shared cluster's credential for one tenant of it (#5283). The console
	// refuses it first (#5327) with lib/clusters/mint-eligibility.ts's copy of this sentence.
	"Kubeconfig mints are not available for an environment placed on a shared cluster.",
];

const ALLOWED: ReadonlySet<string> = new Set(KUBECONFIG_MINT_FAILURE_REASONS);

/**
 * Maps a runner-posted failure reason onto the fixed set: the reason itself when it is one of the
 * sentences above, else {@link KUBECONFIG_MINT_UNKNOWN_FAILURE}. Exact match only — no trimming, no
 * prefix match — so a known sentence with an error appended is still replaced.
 */
export function fixedFailureReason(posted: string): string {
	return ALLOWED.has(posted) ? posted : KUBECONFIG_MINT_UNKNOWN_FAILURE;
}
