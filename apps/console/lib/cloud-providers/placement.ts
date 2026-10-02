// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The one rule for where a component lands: its own cloud identity, else the project's —
// `coalesce(component.cloud_identity_id, projects.cloud_identity_id)` — and then THAT identity's
// provider. The config snapshot places every component with it (buildConfigSnapshot), and
// getProject uses it for the cluster so the cost estimate prices a cluster on the cloud the deploy
// puts it on (#5361). A second copy of this rule is how an estimate and a deploy disagree.

/** The project's own placement — what a component with no identity of its own inherits. */
export interface CorePlacement<I extends string | null, R> {
	cloud_provider: string;
	cloud_identity_id: I;
	region: R;
}

/** The slice of a component row placement reads. Rows without a column simply omit it. */
export interface PlacementRow {
	cloud_identity_id?: string | null;
	region?: string | null;
}

/**
 * Resolves a component row to a concrete `{ cloud_provider, cloud_identity_id, region }`: its own
 * identity and region when set, else the project's. The provider is looked up for the EFFECTIVE
 * identity in `providerById`; an identity the caller could not resolve (absent from the map)
 * falls back to the project's provider, exactly as the snapshot always has.
 */
export function resolveComponentPlacement<I extends string | null, R>(
	core: CorePlacement<I, R>,
	providerById: ReadonlyMap<string, string>,
	row?: PlacementRow | null,
): { cloud_provider: string; cloud_identity_id: string | I; region: string | R } {
	const own = row?.cloud_identity_id;
	const cid: string | I = typeof own === "string" ? own : core.cloud_identity_id;
	const provider = typeof cid === "string" ? providerById.get(cid) : undefined;
	return {
		cloud_provider: provider ?? core.cloud_provider,
		cloud_identity_id: cid,
		region: row?.region ?? core.region,
	};
}
