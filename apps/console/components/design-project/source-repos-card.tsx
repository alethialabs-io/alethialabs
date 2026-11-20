"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { GitBranch, Package } from "lucide-react";
import type { DetectedService } from "@/types/jsonb.types";
import { repoLabel } from "@/lib/repos/repo-label";

/** One scanned repository, as the project root records it. */
export interface SourceRepoRow {
	repo_url: string;
	ref?: string | null;
	scan_path?: string;
	services?: DetectedService[];
}

/**
 * The source repositories (1:N) that were scanned to infer this project and, for a monorepo, the
 * services found in each.
 *
 * It is a list, drawn in the flow of whatever holds it: the board's toolbar opens it from its
 * Sources tool. It used to be a collapsible card pinned to the board's bottom-left corner, which is
 * where the zoom controls are, so the two were drawn on top of each other on every project that
 * had a scanned repository (#6832). Renders nothing for a project with none.
 */
export function SourceReposCard({ repos }: { repos: readonly SourceRepoRow[] }) {
	if (repos.length === 0) return null;
	const serviceCount = repos.reduce((n, r) => n + (r.services?.length ?? 0), 0);

	return (
		<section aria-label="Source repositories" className="border border-border bg-card text-xs">
			<div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5 font-medium">
				<GitBranch aria-hidden className="h-3.5 w-3.5" />
				{repos.length} source {repos.length === 1 ? "repo" : "repos"}
				{serviceCount > 0 && (
					<span className="font-normal text-muted-foreground">
						· {serviceCount} {serviceCount === 1 ? "service" : "services"}
					</span>
				)}
			</div>
			<ul className="max-h-64 overflow-y-auto">
				{repos.map((r) => (
					<li
						key={`${r.repo_url}:${r.scan_path ?? ""}`}
						className="border-b border-border px-2.5 py-1.5 last:border-0"
					>
						<div className="truncate font-mono" title={r.repo_url}>
							{repoLabel(r.repo_url)}
							{r.ref ? <span className="text-muted-foreground"> @{r.ref}</span> : null}
						</div>
						{(r.services ?? []).map((s) => (
							<div
								key={s.path || "root"}
								className="mt-1 flex items-center gap-1.5 pl-2 text-muted-foreground"
							>
								<Package aria-hidden className="h-3 w-3 shrink-0" />
								<span className="truncate">{s.name}</span>
								{s.runtime ? <span>· {s.runtime}</span> : null}
								{s.port ? <span>:{s.port}</span> : null}
							</div>
						))}
					</li>
				))}
			</ul>
		</section>
	);
}
