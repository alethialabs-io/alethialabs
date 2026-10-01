"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { StatusBadge } from "@repo/ui/status-badge";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import {
	type DestroyTreeNode,
	environmentSettingsHref,
	joinNames,
	splitDestroyTree,
} from "./destroy-tree-view";

/** How often a held destroy re-reads what it is waiting on. The env status poll does not carry it. */
const HOLD_POLL_MS = 15_000;

/** One tenant a held DESTROY is waiting on, from the owner's `waiting_on`. */
interface HeldOn {
	name: string;
	status: DestroyTreeNode["status"];
	/** The tenant's environment id, joined from the tree's tenant nodes; null if it was not there. */
	environmentId: string | null;
}

/** A DESTROY that is queued but held back by the environments placed on its cluster. */
export interface DestroyHold {
	/** The held DESTROY job — where cancelling it lives. */
	jobId: string;
	/** What it waits on. Empty means it is not held: it is simply waiting for a runner. */
	waitingOn: HeldOn[];
}

/**
 * Reads what the active environment's queued DESTROY is waiting on (#5261).
 *
 * `claim_next_job` will not hand an owner's DESTROY to a runner while a live tenant remains on its
 * Fabric, so the job sits QUEUED — which, without this, reads exactly like a destroy nobody has
 * picked up yet. This asks the destroy tree only while a DESTROY is QUEUED, and re-asks on an
 * interval because the environment status poll does not carry the tenants.
 *
 * Returns null when nothing is held (no queued DESTROY, no `loadTree`, or the read failed).
 */
export function useDestroyHold(
	loadTree?: () => Promise<DestroyTreeNode[]>,
): DestroyHold | null {
	const env = useEnvironmentStatus();
	const job = env.activeJob;
	const heldJobId = job && job.type === "DESTROY" && job.status === "QUEUED" ? job.id : null;
	const [hold, setHold] = useState<DestroyHold | null>(null);

	useEffect(() => {
		if (!heldJobId || !loadTree) return;
		let cancelled = false;
		/** One read of the tree, folded into the owner's waiting list. */
		const read = () =>
			loadTree()
				.then((tree) => {
					if (cancelled) return;
					const split = splitDestroyTree(tree);
					const ids = new Map<string, string>(
						split?.tenants.map((t): [string, string] => [t.name, t.environment_id]) ?? [],
					);
					setHold({
						jobId: heldJobId,
						waitingOn: (split?.target.waiting_on ?? []).map((w) => ({
							name: w.name,
							status: w.status,
							environmentId: ids.get(w.name) ?? null,
						})),
					});
				})
				.catch(() => {
					// Best-effort: a failed read leaves the last answer (or none) rather than inventing one.
				});
		void read();
		const timer = setInterval(() => void read(), HOLD_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [heldJobId, loadTree]);

	if (!heldJobId || !hold || hold.jobId !== heldJobId) return null;
	return hold;
}

/**
 * "Waiting on dev-1", "Waiting on dev-1 +2" — the short form the board's status line shows in place
 * of "Running" while the destroy is held. Null when nothing is held.
 */
export function waitingOnLabel(hold: DestroyHold | null): string | null {
	if (!hold || hold.waitingOn.length === 0) return null;
	const [first, ...rest] = hold.waitingOn;
	return `Waiting on ${first.name}${rest.length > 0 ? ` +${rest.length}` : ""}`;
}

/**
 * The held destroy, in full, on the Environment settings card: every tenant it waits on with its
 * status, and — for a tenant whose own destroy FAILED, which would otherwise hold the owner forever —
 * the two ways out: retry that tenant's destroy, or cancel this environment's.
 */
export function DestroyHoldNotice({ hold }: { hold: DestroyHold }) {
	const orgSlug = useActiveOrgSlug();
	if (hold.waitingOn.length === 0) return null;
	const failed = hold.waitingOn.filter((w) => w.status === "FAILED");
	const n = hold.waitingOn.length;
	return (
		<div className="space-y-3">
			<Alert>
				<AlertTitle>Destroy queued, waiting on {joinNames(hold.waitingOn.map((w) => w.name))}</AlertTitle>
				<AlertDescription>
					<p>
						This environment owns the cluster, so its destroy starts only after the{" "}
						{n === 1 ? "environment" : `${n} environments`} placed on it {n === 1 ? "is" : "are"}{" "}
						gone.
					</p>
					<ul className="grid w-full gap-1">
						{hold.waitingOn.map((w) => (
							<li key={w.name} className="flex items-center justify-between gap-3 text-ui-md">
								<span className="truncate text-foreground">{w.name}</span>
								<StatusBadge status={w.status} />
							</li>
						))}
					</ul>
				</AlertDescription>
			</Alert>
			{failed.map((w) => (
				<Alert key={w.name} variant="destructive">
					<TriangleAlert />
					<AlertTitle>{w.name} failed, so this destroy is held</AlertTitle>
					<AlertDescription>
						<p>
							This environment&apos;s destroy cannot start while {w.name} is still placed on
							its cluster. There are two ways out:
						</p>
						<ul className="grid gap-1 text-ui-md">
							{w.environmentId && (
								<li>
									<Link
										href={environmentSettingsHref(w.environmentId)}
										className="text-foreground underline underline-offset-2"
									>
										Retry {w.name}&apos;s destroy
									</Link>
								</li>
							)}
							<li>
								<Link
									href={`/${orgSlug}/~/jobs/${hold.jobId}`}
									className="text-foreground underline underline-offset-2"
								>
									Cancel this environment&apos;s destroy
								</Link>
							</li>
						</ul>
					</AlertDescription>
				</Alert>
			))}
		</div>
	);
}
