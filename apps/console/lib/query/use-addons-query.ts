// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseQueryResult,
} from "@tanstack/react-query";
import {
	disableAddon,
	enableAddon,
	getProjectAddons,
	type ProjectAddonsView,
} from "@/app/server/actions/addons";
import { qk } from "./keys";

/**
 * The marketplace catalog joined with an environment's install state. Server-prefetched and
 * hydrated, then polled every 15s so ArgoCD health flips (PENDING → Healthy) surface after a
 * deploy without a manual refresh.
 */
export function useAddonsQuery(
	projectId: string,
	environmentId?: string | null,
): UseQueryResult<ProjectAddonsView> {
	return useQuery({
		queryKey: qk.addons(projectId, environmentId),
		queryFn: () => getProjectAddons(projectId, environmentId),
		refetchInterval: 15_000,
	});
}

/** Invalidates the add-ons cache so the grid reflects an enable/disable on next reconcile. */
function useInvalidateAddons(projectId: string, environmentId?: string | null) {
	const qc = useQueryClient();
	return () =>
		qc.invalidateQueries({ queryKey: qk.addons(projectId, environmentId) });
}

/** Enables or reconfigures an add-on (writes a PENDING row applied on the next deploy). */
export function useEnableAddon(projectId: string, environmentId?: string | null) {
	const invalidate = useInvalidateAddons(projectId, environmentId);
	return useMutation({
		mutationFn: (input: Parameters<typeof enableAddon>[0]) => enableAddon(input),
		onSuccess: () => invalidate(),
	});
}

/** Disables an add-on (removes it from the environment). */
export function useDisableAddon(projectId: string, environmentId?: string | null) {
	const invalidate = useInvalidateAddons(projectId, environmentId);
	return useMutation({
		mutationFn: (input: Parameters<typeof disableAddon>[0]) =>
			disableAddon(input),
		onSuccess: () => invalidate(),
	});
}
