import { type ReactNode } from "react";
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

let activeChannel: ReturnType<
	ReturnType<typeof createClient>["channel"]
> | null = null;

export const useCloudProviderStore = create<CloudProviderStore>()(
	(set, get) => ({
		provider: "aws",
		identityId: null,
		cachedResources: null,
		cachedAt: null,
		isStale: true,
		isLoading: false,

		setIdentity: async (identityId, provider) => {
			set({ identityId, provider, isLoading: true });

			// Tear down previous subscription
			if (activeChannel) {
				const supabase = createClient();
				supabase.removeChannel(activeChannel);
				activeChannel = null;
			}

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
				});
			} catch {
				set({
					cachedResources: null,
					cachedAt: null,
					isStale: true,
					isLoading: false,
				});
			}

			// Subscribe to realtime updates for this identity
			get().subscribe();
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

			if (activeChannel) {
				supabase.removeChannel(activeChannel);
				activeChannel = null;
			}

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

			activeChannel = channel;

			return () => {
				supabase.removeChannel(channel);
				activeChannel = null;
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

export function CloudProviderProvider({
	children,
}: {
	defaultProvider?: CloudProviderSlug;
	children: ReactNode;
}) {
	return <>{children}</>;
}
