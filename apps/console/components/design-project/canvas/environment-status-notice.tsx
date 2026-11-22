"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CircleAlert, Lock } from "lucide-react";
import { Button } from "@repo/ui/button";
import { useEnvironmentStatusLoad } from "./environment-status-scope";

/**
 * The board's one-line answer when the environment-status read produced nothing to show.
 *
 * Without it a failed read was indistinguishable from a healthy one: every node fell back to its
 * DESIGN state, so a database whose deploy FAILED read "Ready to deploy" (RUBRIC B4 — error is not
 * empty). A refusal is said as a refusal and offers no retry, because retrying will not change it.
 * Renders nothing while the read is pending or has an answer.
 *
 * It is drawn in the flow of the board's top-centre region, under the toolbar (#6832). It used to
 * position itself at a fixed offset from the top of the board, which is a second thing to keep clear
 * of whatever else is up there.
 */
export function EnvironmentStatusNotice() {
	const load = useEnvironmentStatusLoad();
	if (!load.failed) return null;

	return (
		<div
			data-slot="environment-status-notice"
			role="alert"
			className="pointer-events-auto flex max-w-full items-center gap-2 border border-border bg-card px-2.5 py-1.5 text-ui-sm"
		>
			{load.forbidden ? (
				<>
					<Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
					<span>You don&apos;t have permission to see this environment&apos;s live status.</span>
				</>
			) : (
				<>
					<CircleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
					<span>Couldn&apos;t load this environment&apos;s live status — cards show their design only.</span>
					<Button type="button" variant="outline" size="sm" className="h-6 px-2 text-ui-sm" onClick={load.retry}>
						Try again
					</Button>
				</>
			)}
		</div>
	);
}
