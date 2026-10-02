// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What a claimed job is handed BESIDES its row (#5308). The claim route used to attach the decrypted
// cloud identity and every connector credential the config_snapshot referenced to EVERY job that
// carried one — so a MINT_KUBECONFIG job, which reuses the latest DEPLOY's snapshot and never reads a
// DNS or registry key, still left the console holding the project's Cloudflare token.
//
// This table is an ALLOW-list, and its two directions are the point:
//   - It is keyed by EVERY provision_job_type (`satisfies { [K in ProvisionJobType]: … }`), so adding a
//     job type to the enum is a type error here until someone writes its row — a deliberate grant.
//   - A job_type string that is not a key (a value the DB grew before this code did) gets NO_GRANT:
//     the job row and nothing else.
//
// Each `true` below is either read by the runner for that type — traced in
// apps/runner/internal/agent/runner.go's dispatch switch (the call that passes claim.CloudIdentity or
// claim.ConnectorCredentials) and the activation block above it — or is marked "kept": the grant the
// route made before #5308, retained because narrowing it was not proven harmless. Nothing here is
// granted for what a type might plausibly want.

import {
	type ProvisionJobType,
	provisionJobType,
} from "@/lib/db/schema/enums";

/** The claim-time secrets one job type may receive. */
export interface ClaimGrant {
	/**
	 * The decrypted cloud identity (role ARN / WIF config / API token). The runner activates it for
	 * every job that carries one, before its handler runs (runner.go, the `claim.CloudIdentity != nil`
	 * block), and a token cloud without it fails activation — so it is granted to every type that runs
	 * against a cloud today.
	 */
	readonly cloudIdentity: boolean;
	/**
	 * Hetzner Object Storage's S3 key pair, a SEPARATE secret from the Cloud API token, exported only
	 * for the tofu minio provider (ActivateHetznerS3). Without it the runner simply skips that export.
	 */
	readonly objectStorageKeys: boolean;
	/**
	 * Decrypted api_key credentials of the pluggable connectors (DNS, secrets, container and Helm
	 * registries, observability) the config_snapshot references. Read only by the handlers that
	 * receive `claim.ConnectorCredentials`: PLAN, DEPLOY, DESTROY and CHART_SCAN.
	 */
	readonly connectorCredentials: boolean;
}

/** Nothing beyond the job row. What an unknown job type receives. */
export const NO_GRANT: ClaimGrant = {
	cloudIdentity: false,
	objectStorageKeys: false,
	connectorCredentials: false,
};

/** The full grant the IaC jobs (tofu against the project's clouds and connectors) receive. */
const IAC: ClaimGrant = {
	cloudIdentity: true,
	objectStorageKeys: true,
	connectorCredentials: true,
};

/**
 * The cloud identity, without any connector credential. The runner's tofu-only and cluster-only
 * handlers (runner, drift, probe, build) are called with claim.CloudIdentity and never with
 * claim.ConnectorCredentials. The object-storage keys are kept: drift runs `tofu plan`, which
 * configures the minio provider, and the runner-infra jobs apply tofu.
 */
const CLOUD_ONLY: ClaimGrant = {
	cloudIdentity: true,
	objectStorageKeys: true,
	connectorCredentials: false,
};

/**
 * The per-job-type allow-list. Rows marked "kept" grant what the claim route attached before #5308
 * because the handler does not take the secret but its absence was not proven harmless; they are
 * listed in the PR for review rather than narrowed silently.
 */
export const CLAIM_GRANTS = {
	PLAN: IAC,
	DEPLOY: IAC,
	DESTROY: IAC,
	// executeChartScan(ctx, job, claim.ConnectorCredentials, …): Helm registry auth for the pull. It
	// takes no cloud identity argument, but the dispatcher activates one when present — kept.
	CHART_SCAN: IAC,
	DEPLOY_RUNNER: CLOUD_ONLY,
	UPDATE_RUNNER: CLOUD_ONLY,
	DESTROY_RUNNER: CLOUD_ONLY,
	DETECT_DRIFT: CLOUD_ONLY,
	PROBE_CLUSTER: CLOUD_ONLY,
	BUILD: CLOUD_ONLY,
	// Handlers take neither claim.CloudIdentity nor claim.ConnectorCredentials, but the dispatcher
	// activates a cloud identity when the job row names one — kept.
	ANALYZE_REPO: CLOUD_ONLY,
	AUDIT: CLOUD_ONLY,
	IAC_SCAN: CLOUD_ONLY,
	STATE_SURGERY: CLOUD_ONLY,
	// executeMintKubeconfig(ctx, job, provider, claim.CloudIdentity, …) — kubeconfig_mint.go. It reads
	// the identity (resolveAccountID, and the dispatcher's activation, which on Hetzner needs the API
	// token), the snapshot, the tofu outputs through the state proxy, and on Hetzner the talosconfig
	// through its own route. It never reads a connector credential, and never runs the minio provider.
	MINT_KUBECONFIG: {
		cloudIdentity: true,
		objectStorageKeys: false,
		connectorCredentials: false,
	},
} satisfies { readonly [K in ProvisionJobType]: ClaimGrant };

/**
 * The grant for a claimed job's type: its CLAIM_GRANTS row, or NO_GRANT for a value this build does
 * not know (the enum grew in the DB first).
 */
export function claimGrantFor(jobType: string): ClaimGrant {
	const known = provisionJobType.enumValues.find((t) => t === jobType);
	return known === undefined ? NO_GRANT : CLAIM_GRANTS[known];
}
