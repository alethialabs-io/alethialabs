"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Check, Plus, RotateCw } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { SwitcherEnv } from "@/app/server/actions/resolve";
import { NewEnvironmentDialog } from "@/components/environments/new-environment-dialog";
import { ShortcutHint } from "@/components/shell/shortcut-hint";
import { SwitcherTrigger } from "@/components/shell/switcher-trigger";
import { readStatusOf } from "@/lib/query/read-status";
import { useProjectsQuery } from "@/lib/query/use-projects-query";
import { FILTER_DEPENDENT_PARAMS, hrefWithParamPatch } from "@/lib/query/view-url-params";
import { orpc } from "@/lib/rpc/client";
import { SHORTCUT_ENVIRONMENT_NEXT } from "@/lib/shortcuts/registry";
import { useShortcut } from "@/lib/shortcuts/use-shortcut";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@repo/ui/command";
import { useCommandSearch } from "@repo/ui/command-search";
import { Button } from "@repo/ui/button";
import { Popover, PopoverContent } from "@repo/ui/popover";
import { Separator } from "@repo/ui/separator";

/** An environment's search text: its name, for the shared ranker. */
const envSearchText = (e: SwitcherEnv): string => e.name;

/** A stable empty list, so effects keyed on `envs` do not re-run on every render before data. */
const NO_ENVS: SwitcherEnv[] = [];

/** The query parameter that names the active environment. */
const ENVIRONMENT_PARAM = "environment_id";

/**
 * The project views that show ONE environment, by their path segment after the project. On these
 * the switcher changes what the page shows. Every other project view — Environments, Jobs,
 * Clusters, Usage, Settings — is about the whole project, and a switcher there changed the
 * address and nothing on screen.
 */
const ENVIRONMENT_VIEWS: ReadonlySet<string> = new Set(["architecture"]);

/** Whether `pathname` is a project view that shows one environment (`/{org}/{project}/architecture…`). */
export function isEnvironmentView(pathname: string): boolean {
	const segs = pathname.split("/").filter(Boolean);
	return (
		segs.length >= 3 &&
		segs[0] !== "dashboard" &&
		segs[1] !== "~" &&
		ENVIRONMENT_VIEWS.has(segs[2])
	);
}

/**
 * The current view with `environmentId` as its active environment. Every other query parameter is
 * kept, except the ones that name something inside the environment being left (a selection), which
 * would point at nothing in the next one.
 */
export function environmentHref(pathname: string, search: string, environmentId: string): string {
	const patch: Record<string, string | null> = { [ENVIRONMENT_PARAM]: environmentId };
	for (const name of FILTER_DEPENDENT_PARAMS) patch[name] = null;
	return hrefWithParamPatch(pathname, search, patch);
}

/**
 * Header environment switcher — the Vercel combobox after org + project. Lists the current
 * project's environments (name + a check on the active one), switches the active env via the
 * `?environment_id=` query param, and hosts the "New environment" dialog. It renders only on a
 * project view that shows one environment ({@link isEnvironmentView}); it is absent from the
 * project's other views, the `~` org-global tree and the bare org overview.
 *
 * While the environments are on the way it draws nothing, as before: the `[project]` layout
 * prefetches them, so that is one frame after a failed prefetch. A read that FAILED used to draw
 * nothing too, and the control simply vanished; it is now a retry in the switcher's place.
 */
export function EnvSwitcher() {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const [open, setOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);

	// The active environment lives in the `?environment_id=` query param, so switching envs keeps
	// the current view and its other parameters and just swaps the id.
	const onEnvironmentView = isEnvironmentView(pathname);
	const [, project] = pathname.split("/").filter(Boolean);
	const envId = searchParams.get(ENVIRONMENT_PARAM) ?? undefined;

	/** The current view with a different active environment. */
	const envUrl = (id: string) => environmentHref(pathname, searchParams.toString(), id);

	/**
	 * Re-scope an OPEN Elench project panel to the environment just picked. The assistant's
	 * plan/deploy proposals are environment-scoped, so a switcher that moved the page but left
	 * the conversation on the old environment would have the assistant answering about somewhere
	 * the user is no longer looking. `syncEnvironment` keeps the thread and the epoch (the
	 * environment is request context, not a new lineage) and no-ops when the panel is closed,
	 * anchored to the org, or on another project. The project id comes free with the rows the
	 * switcher already loaded — no extra resolve round-trip.
	 */
	const syncElench = useCallback(
		(environmentId: string, rows: SwitcherEnv[]) => {
			const projectId = rows[0]?.project_id;
			if (projectId)
				useElenchStore.getState().syncEnvironment(projectId, environmentId);
		},
		[],
	);

	// The project's environments, over the read router (#6114). The `[project]` layout prefetches
	// them for a project that resolves, so the switcher paints with the active env. It asks only for
	// a slug the org's (layout-prefetched) project list contains: a 404 project route makes no
	// request beyond its layout.
	const { data: projects } = useProjectsQuery();
	const knownProject = onEnvironmentView && !!projects?.some((p) => p.slug === project);
	const envsQuery = useQuery({
		...orpc.workspace.environments.queryOptions({ input: { project: project ?? "" } }),
		enabled: knownProject,
	});
	const envs = envsQuery.data ?? NO_ENVS;
	const refetchEnvs = envsQuery.refetch;

	/** Move the current view to the project's next environment, wrapping after the last. */
	const switchToNextEnvironment = () => {
		const current =
			envs.find((x) => x.id === envId) ??
			envs.find((x) => x.is_default) ??
			envs[0];
		const idx = envs.findIndex((x) => x.id === current.id);
		const next = envs[(idx + 1) % envs.length];
		syncElench(next.id, envs);
		router.push(envUrl(next.id));
	};

	// The chord, and where it may fire, are the registry's (`lib/shortcuts/registry.ts`); this only
	// says what it does here. With one environment there is nowhere to switch to, so the chord is
	// left to the browser.
	useShortcut(SHORTCUT_ENVIRONMENT_NEXT, switchToNextEnvironment, {
		enabled: onEnvironmentView && envs.length >= 2,
	});

	// Ranked by the shared ranker; the query starts empty each time the popover opens.
	const envSearch = useCommandSearch(envs, envSearchText, { open });

	if (!onEnvironmentView) return null;

	// The list did not arrive and asking again may help: say so where the switcher would be.
	if (knownProject && readStatusOf(envsQuery) === "error") {
		return (
			<>
				<span className="text-border select-none" aria-hidden>
					/
				</span>
				<Button
					variant="ghost"
					size="sm"
					data-state="error"
					onClick={() => void refetchEnvs()}
					className="gap-2 px-2 text-muted-foreground"
				>
					<RotateCw className="h-3.5 w-3.5 shrink-0" />
					Retry environments
				</Button>
			</>
		);
	}

	if (envs.length === 0) return null;

	const active =
		envs.find((e) => e.id === envId) ??
		envs.find((e) => e.is_default) ??
		envs[0];

	const handleSelect = (id: string) => {
		setOpen(false);
		syncElench(id, envs);
		router.push(envUrl(id));
	};

	/** After creating an env: refresh the list and switch to the new env in the current view. */
	const handleCreated = async (name: string) => {
		const { data: rows = [] } = await refetchEnvs();
		const created = rows.find((e) => e.name === name);
		if (created) {
			syncElench(created.id, rows);
			router.push(envUrl(created.id));
		}
	};

	return (
		<>
			{/* `text-border`, not an ink tier: this slash is an `aria-hidden` separator drawn in the
			    divider colour, so it is chrome rather than ink — but the alpha it used to carry was
			    still an unnamed fifth value, and the named token is the same colour (#4309). */}
			<span className="text-border select-none" aria-hidden>
				/
			</span>
			<Popover open={open} onOpenChange={setOpen}>
				<SwitcherTrigger
					variant="topbar"
					open={open}
					ariaLabel="Switch environment"
					label={active?.name ?? ""}
				/>
				<PopoverContent className="w-64 p-0" align="start">
					<Command
						label="Find environment"
						search={envSearch.search}
						onSearchChange={envSearch.onSearchChange}
						filteredItems={envSearch.results}
					>
						<CommandInput placeholder="Find environment…" className="h-9" />
						<CommandList>
							<CommandEmpty>No environment found.</CommandEmpty>
							{envSearch.results.length > 0 && (
								<CommandGroup heading="Environments">
									{envSearch.results.map((e) => (
										<CommandItem
											key={e.id}
											onSelect={() => handleSelect(e.id)}
											className="gap-2"
										>
											<span className="flex-1 truncate">{e.name}</span>
											{e.id === active?.id && (
												<Check className="h-4 w-4 shrink-0" />
											)}
										</CommandItem>
									))}
								</CommandGroup>
							)}
						</CommandList>
						<Separator />
						{/* An action, not an environment, so a footer button OUTSIDE the listbox: offered on a
						    miss too, reached by click or Tab from the search, never an arrow-key row and
						    never counted as a match (so Enter on a miss runs nothing). */}
						<div className="p-1">
							<Button
								variant="ghost"
								onClick={() => {
									setOpen(false);
									setCreateOpen(true);
								}}
								className="w-full justify-start gap-2 px-2 text-muted-foreground"
							>
								<Plus className="h-4 w-4 shrink-0" />
								<span className="flex-1 text-left">New environment</span>
							</Button>
						</div>
						{/* The shortcut that steps through the list, shown while there is somewhere to
						    step to. Read from the registry, so it is the chord the listener answers. */}
						{envs.length >= 2 && (
							<p className="flex items-center justify-between gap-2 border-t px-3 py-2 text-ui-sm text-muted-foreground">
								Next environment
								<ShortcutHint id={SHORTCUT_ENVIRONMENT_NEXT} />
							</p>
						)}
					</Command>
				</PopoverContent>
			</Popover>

			<NewEnvironmentDialog
				open={createOpen}
				onOpenChange={setCreateOpen}
				projectId={envs[0]?.project_id ?? ""}
				envs={envs}
				onCreated={handleCreated}
			/>
		</>
	);
}
