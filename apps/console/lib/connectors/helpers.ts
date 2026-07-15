// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import type { Connector } from "@/lib/db/schema";
import {
	getProvidersForCategory,
	type ConnectorProviderMeta,
	type PluggableCategory,
} from "./registry.generated";

/** Which connect flow a connector opens. */
export type ConnectFlow = "git" | "cloud" | "api_key";

/**
 * Picks the connect flow for a connector — **category wins over auth_method**.
 *
 * This is the fix for the blank Hetzner/Civo/DigitalOcean sheet: the token clouds are
 * `category: "cloud"` but `auth_method: "api_key"` (the enum has no `token` value). Routing on
 * auth_method first sent them to the *pluggable* api-key sheet, whose registry has no entry for
 * them, so it rendered `null` — an empty panel. A cloud is always a cloud; only a non-cloud
 * api_key connector (vault / cloudflare / dockerhub / …) takes the pluggable path.
 */
export function connectRoute(
	integration: Pick<Connector, "category" | "auth_method">,
): ConnectFlow {
	if (integration.category === "git") return "git";
	if (integration.category === "cloud") return "cloud";
	// Non-cloud, non-git → the pluggable api-key sheet (vault / cloudflare / dockerhub / …). Anything
	// without a real api_key method has no connect flow today, but the pluggable sheet is the only
	// non-cloud/non-git surface, so route there rather than silently no-op.
	return "api_key";
}

/** Slugs of connectors the current user has actually connected. */
export function connectedSlugs(connectors: ConnectorWithConnection[]): Set<string> {
	return new Set(connectors.filter((c) => c.connected).map((c) => c.slug));
}

/**
 * Pluggable providers in a category that the user has connected — the source of
 * truth for the design-project's per-component option lists. A provider the user
 * hasn't connected is dropped, so they can't select something that would fail at
 * provision time.
 */
export function connectedProvidersForCategory(
	category: PluggableCategory,
	connectors: ConnectorWithConnection[],
): ConnectorProviderMeta[] {
	const connected = connectedSlugs(connectors);
	return getProvidersForCategory(category).filter((p) => connected.has(p.slug));
}
