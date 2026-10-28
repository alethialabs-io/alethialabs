// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
	disableAddonAction,
	enableAddonAction,
	type ProjectAddonsView,
} from "@/app/server/actions/addons";
import {
	type ActionMutationOptions,
	useActionMutation,
} from "@/lib/actions/use-action-mutation";
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
 * Every key that shows an add-on's install state: the catalog itself, and the environment status
 * (an installed add-on is a node on the board, with its health and sync).
 */
function addonKeys() {
	return [orpc.canvas.addons.key(), orpc.canvas.environmentStatus.key()];
}

/** What a caller of the add-on writes may hand the mutation: where refusals and field errors go. */
type AddonWriteOptions<T, V> = Pick<
	ActionMutationOptions<T, V>,
	"onRefusal" | "onValidationError" | "successMessage" | "onSuccess"
>;

/**
 * Enables or reconfigures an add-on (writes a PENDING row applied on the next deploy), on the
 * mutation contract: pending while in flight, refusals and field errors routed by kind, and every
 * key that shows the add-on invalidated when it settles.
 */
export function useEnableAddon(
	options: AddonWriteOptions<
		{ addonId: string },
		Parameters<typeof enableAddonAction>[0]
	> = {},
) {
	return useActionMutation(enableAddonAction, { ...options, invalidates: addonKeys() });
}

/** Disables an add-on (removes it from the environment), on the mutation contract. */
export function useDisableAddon(
	options: AddonWriteOptions<
		{ addonId: string },
		Parameters<typeof disableAddonAction>[0]
	> = {},
) {
	return useActionMutation(disableAddonAction, { ...options, invalidates: addonKeys() });
}
