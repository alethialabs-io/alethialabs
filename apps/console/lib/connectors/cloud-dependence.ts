// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Which connectors depend on a cloud being offered — the one rule, for the Connectors board's
// listing (components/connectors/connectors-query.ts) and the server action that saves a connector
// credential (app/server/actions/connectors.ts). Two copies of it would let the page hide a
// connector the server still accepts, which #6816 recorded on #6964.
//
// Pure, with no server-only import: the board runs it in the browser over the offered set the
// server handed it, and the action runs it over `offeredClouds()`.

/** The catalog fields the rule reads, as both the board's rows and the `connectors` table carry them. */
interface CatalogConnectorShape {
	slug: string;
	category: string;
	auth_method: string;
}

/**
 * Whether a connector signs in with the CLUSTER'S OWN cloud identity instead of a credential the
 * user gives it. That is every connector outside the cloud group whose `auth_method` is not
 * `api_key` and not `oauth`: the cross-account stores and registries, which hold no credential
 * fields and work only from a cluster running in the cloud whose identity they use.
 */
function usesClusterCloudIdentity(
	connector: Pick<CatalogConnectorShape, "category" | "auth_method">,
): boolean {
	return (
		connector.category !== "cloud" &&
		connector.auth_method !== "api_key" &&
		connector.auth_method !== "oauth"
	);
}

/**
 * Whether the cloud a connector needs is offered by this deployment. True for every connector that
 * takes its own credential ({@link usesClusterCloudIdentity} is false), whoever makes it: a registry
 * that needs only an API token can be pulled from any cluster.
 *
 * For one that signs in with the cluster's identity, the cloud is found by `auth_method`: such a
 * connector shares its method with exactly the cloud whose identity it uses. It is offered while a
 * cloud row of `catalog` with that method is in `offeredClouds`. Derived from the method, never
 * from a list of connector names, so a new cross-account connector is covered without an edit here.
 */
export function connectorCloudOffered(
	connector: Pick<CatalogConnectorShape, "category" | "auth_method">,
	catalog: readonly CatalogConnectorShape[],
	offeredClouds: readonly string[],
): boolean {
	if (!usesClusterCloudIdentity(connector)) return true;
	return catalog.some(
		(row) =>
			row.category === "cloud" &&
			row.auth_method === connector.auth_method &&
			offeredClouds.includes(row.slug),
	);
}
