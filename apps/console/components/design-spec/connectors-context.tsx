"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext, useContext, type ReactNode } from "react";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { connectedProvidersForCategory } from "@/lib/connectors/helpers";
import type {
	ConnectorProviderMeta,
	PluggableCategory,
} from "@/lib/connectors/registry.generated";

const ConnectorsContext = createContext<ConnectorWithConnection[]>([]);

/**
 * Carries the user's connectors (with connection status) into the design-spec
 * sections so each component can offer only the providers actually connected.
 * Mirrors RepositoryProvider, but the data is server-fetched and passed in.
 */
export function ConnectorsProvider({
	connectors,
	children,
}: {
	connectors: ConnectorWithConnection[];
	children: ReactNode;
}) {
	return (
		<ConnectorsContext.Provider value={connectors}>
			{children}
		</ConnectorsContext.Provider>
	);
}

export function useConnectors(): ConnectorWithConnection[] {
	return useContext(ConnectorsContext);
}

/** Connected pluggable providers for a category (e.g. DNS → [Cloudflare] if connected). */
export function useConnectedProviders(
	category: PluggableCategory,
): ConnectorProviderMeta[] {
	return connectedProvidersForCategory(category, useConnectors());
}
