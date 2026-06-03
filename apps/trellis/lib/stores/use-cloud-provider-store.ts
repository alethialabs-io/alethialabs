import { create } from "zustand";
import { createClient } from "@/lib/supabase/client";
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
			const supabase = createClient();
			const { identityId } = get();

			if (!identityId) return () => {};

			const channel = supabase
				.channel(`cloud-identity-${identityId}`)
				.on(
					"postgres_changes",
					{
						event: "UPDATE",
						schema: "public",
						table: "cloud_identities",
						filter: `id=eq.${identityId}`,
					},
					(payload) => {
						const row = payload.new as {
							cached_resources: AnyCachedResources | null;
							cached_at: string | null;
						};
						if (row.cached_resources && row.cached_at) {
							get().updateResources(
								row.cached_resources,
								row.cached_at,
							);
						}
					},
				)
				.subscribe();

			return () => {
				supabase.removeChannel(channel);
			};
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
