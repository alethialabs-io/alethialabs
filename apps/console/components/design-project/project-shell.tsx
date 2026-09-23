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
			{/* THE CANVAS IS PINNED TO ONE VIEWPORT; A DOCUMENT IS NOT.
			    `SHELL_VIEWPORT` is one viewport less the topbar — it reads the shell's header
			    height, where this used to reserve 3.5rem (56px) against a 53px topbar and
			    overflowed by 3px. A pan/zoom board needs that pin: it has to fill exactly the
			    space it is given and scroll nothing.

			    A document view must NOT have it, and that is RUBRIC.md R3 — "exactly one scroll
			    container, and it is the shell's". Pinning this frame to the viewport makes
			    `AppShell`'s `<main className="flex-1 overflow-y-auto">` un-overflowable (its only
			    child is exactly its own height), so the `overflow-y-auto` that used to sit on the
			    document wrapper below became the page's ONE scroller and it was not `<main>`. That
			    is invisible until a project view grows past the viewport — every project document
			    route happened to fit, so nothing reported it until #4914 added the jobs count
			    toolbar and pushed `/[org]/[project]/jobs` 18–50px over at 768/1280/1440/1920.
			    Un-pinned, the document flows in `<main>` exactly as every `/[org]/~/…` route does,
			    which is the console's one scrolling pattern rather than a second one.

			    The `-m-4 … -m-10` / `p-4 … p-10` round trip stays on both branches: it cancels
			    AppShell's gutter (which the canvas needs gone) and re-applies it for a document, so
			    the two branches share one frame and a document's gutter is the console's. */}
			<div
				className={cn(
					"-m-4 flex sm:-m-6 lg:-m-8 xl:-m-10",
					onArchitecture && SHELL_VIEWPORT,
				)}
			>
				<div className="relative min-w-0 flex-1">
					{/* Architecture fills the board full-bleed — a pan/zoom canvas has no document
					    width, and centring it inside CONTENT_FRAME would leave gutters the board is
					    meant to use. Every other project view is a document and gets the console's
					    one content frame, the same 1200px SettingsShell and SupportShell own. */}
					{onArchitecture ? (
						<div className="h-full">{children}</div>
					) : (
						<div className="p-4 sm:p-6 lg:p-8 xl:p-10">
							<div className={CONTENT_FRAME}>{children}</div>
						</div>
					)}
				</div>
			</div>
		</EnvironmentStatusProvider>
	);
}
