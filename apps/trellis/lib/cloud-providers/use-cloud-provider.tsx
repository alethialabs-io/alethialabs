"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import type { CloudProviderSlug } from "./registry";
import { PROVIDERS } from "./registry";
import type {
	CachedResources,
	GcpCachedResources,
	AzureCachedResources,
} from "@/types/database-custom.types";

/** Union of all provider-specific cached resource shapes. */
export type AnyCachedResources =
	| CachedResources
	| GcpCachedResources
	| AzureCachedResources;

interface CloudProviderState {
	/** Currently selected cloud provider slug. Defaults to "aws". */
	provider: CloudProviderSlug;
	/** ID of the selected cloud identity. */
	identityId: string | null;
	/** Cached cloud resources loaded from the selected identity. */
	cachedResources: AnyCachedResources | null;
	/** Set the active cloud identity, deriving the provider from it. */
	setIdentity: (identityId: string, provider: CloudProviderSlug, resources: AnyCachedResources | null) => void;
}

const CloudProviderContext = createContext<CloudProviderState | null>(null);

/** Provides the current cloud provider context to all vine form sections. */
export function CloudProviderProvider({
	defaultProvider = "aws",
	children,
}: {
	defaultProvider?: CloudProviderSlug;
	children: ReactNode;
}) {
	const [provider, setProvider] = useState<CloudProviderSlug>(defaultProvider);
	const [identityId, setIdentityId] = useState<string | null>(null);
	const [cachedResources, setCachedResources] = useState<AnyCachedResources | null>(null);

	const setIdentity = useCallback(
		(id: string, prov: CloudProviderSlug, resources: AnyCachedResources | null) => {
			setIdentityId(id);
			setProvider(prov);
			setCachedResources(resources);
		},
		[],
	);

	return (
		<CloudProviderContext.Provider value={{ provider, identityId, cachedResources, setIdentity }}>
			{children}
		</CloudProviderContext.Provider>
	);
}

/** Returns the current cloud provider context. Must be used within CloudProviderProvider. */
export function useCloudProvider(): CloudProviderState {
	const ctx = useContext(CloudProviderContext);
	if (!ctx) {
		throw new Error("useCloudProvider must be used within CloudProviderProvider");
	}
	return ctx;
}

/** Shorthand: returns just the provider slug. */
export function useProviderSlug(): CloudProviderSlug {
	return useCloudProvider().provider;
}

/** Returns the provider metadata for the current selection. */
export function useProviderMeta() {
	const { provider } = useCloudProvider();
	return PROVIDERS[provider];
}
