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
	type ProjectAddonsView,
} from "@/app/server/actions/addons";
import { orpc } from "@/lib/rpc/client";
import { environmentStatusInput } from "./use-environment-status-query";

/**
 * The marketplace catalog joined with an environment's install state — the `canvas.addons` GET
 * procedure (ADR 0005 D1, #6119), prefetched by the Architecture page.
 *
 * No poll. It used to refetch every 15 s so an ArgoCD health flip (PENDING → Healthy) surfaced after
 * a deploy; that flip is a write to `project_addons`, which is now an `addons` hint on the org's
 * change stream and invalidates this key (`lib/query/topics.ts`).
 */
export function useAddonsQuery(
	projectId: string | undefined,
	environmentId?: string | null,
): UseQueryResult<ProjectAddonsView> {
	return useQuery({
		...orpc.canvas.addons.queryOptions({
			input: environmentStatusInput(projectId ?? "", environmentId),
		}),
		// Absent in the create flow (no project/environment yet) — don't fetch.
		enabled: !!projectId,
	});
}

/**
 * Invalidates every key that shows an add-on's install state: the catalog itself, and the
 * environment status (an installed add-on is a node on the board, with its health and sync).
 */
function useInvalidateAddons() {
	const qc = useQueryClient();
	return () =>
		Promise.all([
			qc.invalidateQueries({ queryKey: orpc.canvas.addons.key() }),
			qc.invalidateQueries({ queryKey: orpc.canvas.environmentStatus.key() }),
		]);
}

/** Enables or reconfigures an add-on (writes a PENDING row applied on the next deploy). */
export function useEnableAddon() {
	const invalidate = useInvalidateAddons();
	return useMutation({
		mutationFn: (input: Parameters<typeof enableAddon>[0]) => enableAddon(input),
		onSuccess: () => invalidate(),
	});
}

/** Disables an add-on (removes it from the environment). */
export function useDisableAddon() {
	const invalidate = useInvalidateAddons();
	return useMutation({
		mutationFn: (input: Parameters<typeof disableAddon>[0]) =>
			disableAddon(input),
		onSuccess: () => invalidate(),
	});
}
