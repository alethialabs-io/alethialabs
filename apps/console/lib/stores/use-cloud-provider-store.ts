// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";
import { getCachedResources } from "@/app/server/actions/aws/resources";
import type { CloudProviderSlug } from "@/lib/cloud-providers/registry";
import { CACHE_TTL_HOURS, PROVIDERS } from "@/lib/cloud-providers/registry";
import type {
	CachedResources,
	GcpCachedResources,
	AzureCachedResources,
} from "@/types/database-custom.types";

export type AnyCachedResources =
	| CachedResources
	| GcpCachedResources
	| AzureCachedResources;

interface CloudProviderStore {
	provider: CloudProviderSlug;
	identityId: string | null;
	cachedResources: AnyCachedResources | null;
	cachedAt: string | null;
	isStale: boolean;
	isLoading: boolean;
	error: string | null;
	_cleanup: (() => void) | null;

	setIdentity: (
		identityId: string,
		provider: CloudProviderSlug,
	) => Promise<void>;
	updateResources: (
		resources: AnyCachedResources | null,
		cachedAt: string,
	) => void;
	subscribe: () => () => void;
}

export const useCloudProviderStore = create<CloudProviderStore>()(
	(set, get) => ({
		provider: "aws",
		identityId: null,
		cachedResources: null,
		cachedAt: null,
		isStale: true,
		isLoading: false,
		error: null,
		_cleanup: null,

		setIdentity: async (identityId, provider) => {
			const prevCleanup = get()._cleanup;
			if (prevCleanup) {
				prevCleanup();
				set({ _cleanup: null });
			}

			set({ identityId, provider, isLoading: true, error: null });

			try {
				const { resources, cachedAt } =
					await getCachedResources(identityId);
				const isStale = cachedAt
					? Date.now() - new Date(cachedAt).getTime() >
						CACHE_TTL_HOURS * 3600 * 1000
					: true;
				set({
					cachedResources: resources,
					cachedAt,
					isStale,
					isLoading: false,
					error: null,
				});
			} catch (err) {
				set({
					cachedResources: null,
					cachedAt: null,
					isStale: true,
					isLoading: false,
					error: err instanceof Error ? err.message : "Failed to load cloud resources",
				});
			}

			const cleanup = get().subscribe();
			set({ _cleanup: cleanup });
		},

		updateResources: (resources, cachedAt) => {
			const isStale =
				Date.now() - new Date(cachedAt).getTime() >
				CACHE_TTL_HOURS * 3600 * 1000;
			set({ cachedResources: resources, cachedAt, isStale });
		},

		subscribe: () => {
			// Supabase Realtime retired. cloud_identities.cached_resources refreshes
			// via the explicit FETCH_RESOURCES job flow (refreshCloudResources →
			// poll → completeResourceRefresh → updateResources), so no live channel.
			return () => {};
		},
	}),
);

export function useProviderSlug(): CloudProviderSlug {
	return useCloudProviderStore((s) => s.provider);
}

export function useProviderMeta() {
	const provider = useProviderSlug();
	return PROVIDERS[provider];
}
