// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import {
	getProvidersForCategory,
	type ConnectorProviderMeta,
	type PluggableCategory,
} from "./registry.generated";

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
