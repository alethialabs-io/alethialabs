"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// WHAT A PERSON CAN DO ABOUT A CLUSTER FOUND DELETED OUTSIDE ALETHIA (#6736).
//
// Alethia never changes a missing cluster's status by itself; it shows the evidence and offers three
// ways out, each of them a click:
//
//   · Redeploy — opens the environment on the architecture board, where its Deploy recreates the
//     cluster. The existing deploy, with its gates and approvals; nothing new is invented here.
//   · Tear down — the same board, whose environment settings hold the existing Destroy (the
//     `env.destroy` control), which runs the teardown job over whatever is left.
//   · Mark as destroyed — records the environment and its cluster as destroyed with NO cloud call
//     (app/server/actions/missing-cluster.ts), for a cluster that is gone for good. Its confirmation
//     says plainly what it does not do.
//
// Rendered by the cluster card and by the environment card, so both offer the same three.

import { Button } from "@repo/ui/button";
import Link from "next/link";
import { useState } from "react";
import { markEnvironmentDestroyedAction } from "@/app/server/actions/missing-cluster";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { orpc } from "@/lib/rpc/client";
import { envHref } from "@/lib/routing";

/** The confirmation's body: what marking does, and — plainly — what it does not. */
export const MARK_DESTROYED_DESCRIPTION =
	"Alethia records this environment and its cluster as destroyed. No cloud resources are touched and no job runs: anything that still exists in the cloud account (node pools, disks, load balancers, networks) is yours to check and remove there. The environment's history (jobs, drift scans, probes and the activity log) is kept, and you can deploy it again later.";

export interface MissingClusterActionsProps {
	orgSlug: string;
	/** The project's URL slug; without one there is no board to link to, and only the mark is offered. */
	projectSlug: string | null;
	projectId: string;
	environmentId: string;
	environmentName: string;
	className?: string;
}

/** The three ways to resolve a missing cluster: redeploy, tear down, or mark it destroyed. */
export function MissingClusterActions({
	orgSlug,
	projectSlug,
	projectId,
	environmentId,
	environmentName,
	className,
}: MissingClusterActionsProps) {
	const [confirming, setConfirming] = useState(false);
	const mark = useActionMutation(markEnvironmentDestroyedAction, {
		invalidates: [orpc.clusters.key(), orpc.environments.key(), orpc.workspace.environments.key()],
		successMessage: `Marked ${environmentName} as destroyed`,
	});
	const board = projectSlug ? envHref(orgSlug, projectSlug, environmentId) : null;

	return (
		<div data-slot="missing-cluster-actions" className={className}>
			<div className="flex flex-wrap items-center gap-2">
				{board && (
					<>
						<Button variant="outline" size="sm" nativeButton={false} render={<Link href={board} />}>
							Redeploy
						</Button>
						<Button variant="outline" size="sm" nativeButton={false} render={<Link href={board} />}>
							Tear down
						</Button>
					</>
				)}
				<Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
					Mark as destroyed
				</Button>
			</div>
			{board && (
				<p className="mt-1.5 text-ui-2xs text-text-tertiary">
					Redeploy and Tear down open the environment on the board, where its Deploy and its Destroy
					run. Nothing changes until you choose.
				</p>
			)}
			<ConfirmAction
				open={confirming}
				onOpenChange={setConfirming}
				title={`Mark ${environmentName} as destroyed?`}
				description={MARK_DESTROYED_DESCRIPTION}
				confirmLabel="Mark as destroyed"
				pendingLabel="Marking…"
				severity={{ level: "confirm" }}
				mutation={mark}
				variables={confirming ? { projectId, environmentId } : null}
			/>
		</div>
	);
}
