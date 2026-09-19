"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The project workspace shell: a full-bleed frame around the routed view. It owns the ONE
// environment-status query every project view reads, and the content frame for the document views.
// The workspace rail (inspector, environment settings, add-on config, scan verdicts) used to be
// docked here so it could outlive a view switch; it is canvas-only and now lives inside the canvas,
// where every card sits under the providers it needs and closes with it.

import { usePathname, useSearchParams } from "next/navigation";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { CONTENT_FRAME } from "@/components/shell/content-frame";
import { SHELL_VIEWPORT } from "@/components/shell/shell-metrics";
import { EMPTY_ENVIRONMENT_STATUS } from "@/lib/canvas/component-status";
import { EnvironmentStatusProvider } from "@/lib/canvas/environment-status-context";
import { useEnvironmentStatusQuery } from "@/lib/query/use-environment-status-query";
import { cn } from "@repo/ui/utils";

/** The project workspace frame: env status for every view, full-bleed on Architecture. */
export function ProjectShell({
	projectId,
	children,
}: {
	projectId: string;
	/** Kept for the layout's call site; the canvas seeds identities into its store itself. */
	identities?: CloudIdentityOption[];
	children: React.ReactNode;
}) {
	const pathname = usePathname();
	const searchParams = useSearchParams();

	// Architecture is the only env-scoped design surface.
	const onArchitecture = pathname.endsWith("/architecture");

	// The environment's server truth (component lifecycles, the in-flight job, drift, cluster
	// liveness) — fetched ONCE here, because the shell is the only place that wraps every project
	// view. Forty cards each running their own query would be forty round-trips and forty poll
	// timers; instead every node picks its row out of this by `nodeStatusKey()`. An absent
	// `environment_id` resolves to the project's default env server-side, exactly as the
	// Architecture page does.
	const envStatus = useEnvironmentStatusQuery(
		projectId,
		searchParams.get("environment_id"),
	);

	return (
		<EnvironmentStatusProvider value={envStatus.data ?? EMPTY_ENVIRONMENT_STATUS}>
			{/* One viewport less the topbar — `SHELL_VIEWPORT` reads the shell's header height, where
			    this used to reserve 3.5rem (56px) against a 53px topbar and overflowed by 3px. */}
			<div className={cn("-m-4 flex sm:-m-6 lg:-m-8 xl:-m-10", SHELL_VIEWPORT)}>
				<div className="relative min-w-0 flex-1">
					{/* Architecture fills the board full-bleed — a pan/zoom canvas has no document
					    width, and centring it inside CONTENT_FRAME would leave gutters the board is
					    meant to use. Every other project view is a document and gets the console's
					    one content frame, the same 1200px SettingsShell and SupportShell own. */}
					{onArchitecture ? (
						<div className="h-full">{children}</div>
					) : (
						<div className="h-full overflow-y-auto p-4 sm:p-6 lg:p-8 xl:p-10">
							<div className={CONTENT_FRAME}>{children}</div>
						</div>
					)}
				</div>
			</div>
		</EnvironmentStatusProvider>
	);
}
