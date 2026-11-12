"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { preloadElenchSurface } from "@/components/agent/elench/elench-surface-loader";
import { orpc } from "@/lib/rpc/client";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { projectScope } from "./nav-config";

/**
 * The "Ask AI" launcher — a topbar action (beside the setup guide), available on every
 * authenticated view. Toggles the Elench assistant as a docked panel, scoped to the current
 * project AND the environment the topbar switcher is showing when inside a project workspace
 * (resolves the slug → id on click) and org-wide otherwise. Replaces the old floating
 * bottom-right pill.
 *
 * The slug → id lookup reads the org's project list — the GET read the `[org]` layout prefetched
 * (`workspace.projects`), so a click normally asks nothing — and fetches it over GET only when the
 * cache does not hold it. It used to call the `resolveProjectId` SERVER ACTION, a read travelling
 * as a POST that queues behind every other action on the page (ADR 0005 D1, #6114).
 */
export function AskAiButton() {
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const togglePanel = useElenchStore((s) => s.togglePanel);
	const queryClient = useQueryClient();

	/** The id of the project `slug` names in this org, or null when it is not in the list. */
	const projectIdOf = async (slug: string): Promise<string | null> => {
		try {
			const projects = await queryClient.ensureQueryData(orpc.workspace.projects.queryOptions());
			return projects.find((p) => p.slug === slug)?.id ?? null;
		} catch {
			return null;
		}
	};

	const onClick = async () => {
		const scope = projectScope(pathname);
		const projectId = scope ? await projectIdOf(scope.projectSlug) : null;
		if (scope && projectId) {
			// The environment the user is LOOKING AT. Null means "the project's default",
			// which the route resolves server-side — the same contract the canvas uses. Read
			// at click time so the panel opens on the switcher's current environment rather
			// than silently planning against the default.
			// `environmentId` is always an ANSWER from here, never an absence: this button only
			// reaches this branch inside a project workspace, where the absence of
			// `?environment_id=` means the project's default. The store distinguishes the two —
			// omitting the field means "I cannot see one", and passing null means "the default"
			// — so passing the raw lookup re-scopes correctly in both directions.
			togglePanel({
				kind: "project",
				projectId,
				projectSlug: scope.projectSlug,
				environmentId: searchParams.get("environment_id"),
			});
			return;
		}
		// Org context when there is no project scope, or the project cannot be resolved.
		togglePanel({ kind: "org" });
	};

	return (
		<Button
			variant="ghost"
			size="sm"
			onClick={onClick}
			onPointerEnter={preloadElenchSurface}
			onFocus={preloadElenchSurface}
			aria-label="Ask AI"
			className="h-9 gap-2 text-muted-foreground hover:text-foreground"
		>
			<Sparkles className="h-4 w-4" />
			<span className="hidden sm:inline">Ask AI</span>
		</Button>
	);
}
