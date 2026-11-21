"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One environment's auto-heal switch. Each row mounts its own, so each has its own in-flight state:
// a change on one environment neither blocks nor is dropped by a change on another. The switch
// moves at once (an optimistic patch of the page's read, rolled back if the write fails) and is
// disabled until its own write has settled, which is the double-submit guard.

import { DisabledReason } from "@repo/ui/disabled-reason";
import { Switch } from "@repo/ui/switch";
import type { QueryKey } from "@tanstack/react-query";
import { setAutoHeal } from "@/app/server/actions/projects";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { orpc } from "@/lib/rpc/client";
import type { EnvironmentsOverview } from "@/lib/rpc/procedures/environments";
import { settleThrown } from "./settle-action";

/** Narrows a cached value to the Environments page's read. */
function isOverview(value: unknown): value is EnvironmentsOverview {
	return typeof value === "object" && value !== null && "reconcile" in value && Array.isArray(value.reconcile);
}

/**
 * The page's read with one environment's auto-heal set to `enabled` — the optimistic patch. A value
 * that is not the read (nothing cached yet) is returned as it is.
 */
export function withAutoHeal(current: unknown, environmentId: string, enabled: boolean): unknown {
	if (!isOverview(current)) return current;
	return {
		...current,
		reconcile: current.reconcile.map((state) =>
			state.environmentId === environmentId ? { ...state, autoHeal: enabled } : state,
		),
	};
}

/** The switch. `deniedReason` disables it with its reason for a viewer who may not change it. */
export function AutoHealSwitch({
	projectId,
	environmentId,
	environmentName,
	enabled,
	overviewKey,
	deniedReason,
}: {
	projectId: string;
	environmentId: string;
	environmentName: string;
	/** What the page's read says the setting is. */
	enabled: boolean;
	/** The key of the read the page is showing, which the optimistic patch writes. */
	overviewKey: QueryKey;
	deniedReason: string | null;
}) {
	const heal = useActionMutation(
		(next: boolean) =>
			settleThrown(async () => {
				await setAutoHeal(projectId, environmentId, next);
				return next;
			}),
		{
			invalidates: [orpc.environments.key()],
			optimistic: [{ key: overviewKey, update: (current, next) => withAutoHeal(current, environmentId, next) }],
			successMessage: (next) => `Auto-heal ${next ? "on" : "off"} for ${environmentName}`,
		},
	);
	return (
		<DisabledReason reason={deniedReason}>
			<Switch
				checked={enabled}
				disabled={heal.isPending}
				aria-busy={heal.isPending || undefined}
				onCheckedChange={(next) => heal.submit(next)}
				aria-label={`Toggle auto-heal for ${environmentName}`}
			/>
		</DisabledReason>
	);
}
