"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
	getEnvironmentsForSlug,
	type SwitcherEnv,
} from "@/app/server/actions/resolve";
import { projectScope } from "@/components/shell/nav-config";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { cn } from "@repo/ui/utils";

/**
 * The name of the environment an Elench project conversation is scoped to, or null while it is
 * unknown.
 *
 * Two sources, cheapest first. `useEnvironmentStatus()` is free — it is the environment the
 * canvas already fetched — but it only answers under `ProjectShell`'s provider, and the Elench
 * surface is mounted in the app shell as a SIBLING of `<main>` (so the panel can squeeze the main
 * column), which is outside it. So the common case falls through to the same server action the
 * topbar switcher uses, resolved by the project slug in the path. Both degrade to null rather
 * than throwing: a chip that cannot name the environment says "project", never a wrong name.
 */
function useScopeEnvironmentName(
	environmentId: string | null,
	enabled: boolean,
): string | null {
	const status = useEnvironmentStatus();
	const pathname = usePathname();
	const slug = projectScope(pathname)?.projectSlug;
	const [envs, setEnvs] = useState<SwitcherEnv[]>([]);

	// A null `environmentId` means "the project's default", which only the server can name — so
	// the list is fetched either way, and matched by id or by `is_default`.
	const fromStatus =
		status.environment &&
		(environmentId === null || status.environment.id === environmentId)
			? status.environment.name
			: null;

	useEffect(() => {
		if (!enabled || fromStatus !== null || !slug) return;
		let live = true;
		void getEnvironmentsForSlug(slug)
			.then((rows) => {
				if (live) setEnvs(rows);
			})
			.catch(() => {
				if (live) setEnvs([]);
			});
		return () => {
			live = false;
		};
	}, [enabled, fromStatus, slug]);

	if (fromStatus !== null) return fromStatus;
	const match =
		environmentId === null
			? envs.find((e) => e.is_default)
			: envs.find((e) => e.id === environmentId);
	return match?.name ?? null;
}

/**
 * The Elench scope chip — `project · environment` in the panel and modal headers.
 *
 * A project conversation plans and deploys against ONE environment, and until this chip the
 * surface said nothing about which: the same panel, on the same thread, answered about production
 * or about staging depending on a query param the user could not see from inside the drawer.
 * Renders nothing for an org conversation (there is no scope to name) and drops the environment
 * half — rather than guessing — when the name has not resolved.
 */
export function ElenchScopeChip({ className }: { className?: string }) {
	const ctx = useElenchStore((s) => s.ctx);
	const pathname = usePathname();
	const isProject = ctx.kind === "project";
	const envName = useScopeEnvironmentName(
		ctx.kind === "project" ? ctx.environmentId : null,
		isProject,
	);

	if (!isProject) return null;

	// The slug the CONVERSATION was opened on, not the one in the current path. The panel is mounted
	// in the app shell and survives navigation, and nothing re-scopes it on a project change — so
	// reading the pathname relabelled a conversation still anchored to the previous project, and
	// with a null environment it went on to name that project's default env too. A fully wrong
	// scope, stated confidently, in the component whose job is to state the scope. Found in review.
	//
	// Falling back to the path only when the two agree keeps the old behaviour for every case that
	// was already correct: a conversation opened here, on this project.
	const here = projectScope(pathname)?.projectSlug;
	const project = ctx.projectSlug ?? here ?? "Project";

	return (
		<span
			data-testid="elench-scope-chip"
			title={envName ? `${project} · ${envName}` : project}
			className={cn(
				"inline-flex min-w-0 items-center text-ui-xs text-muted-foreground",
				className,
			)}
		>
			<span className="truncate">{project}</span>
			{envName ? (
				<>
					<span aria-hidden className="px-1 text-border">
						·
					</span>
					<span className="truncate text-foreground">{envName}</span>
				</>
			) : null}
		</span>
	);
}
