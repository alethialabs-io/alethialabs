"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ChevronDown, GitBranch, Package } from "lucide-react";
import { useMemo, useState } from "react";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import type { DetectedService } from "@/types/jsonb.types";
import { cn } from "@repo/ui/utils";

interface SourceRepoRow {
	repo_url: string;
	ref?: string | null;
	scan_path?: string;
	services?: DetectedService[];
}

/** Short display name for a repo URL (last path segment, .git stripped). */
function repoLabel(url: string): string {
	return url.replace(/\.git$/, "").split("/").filter(Boolean).slice(-2).join("/") || url;
}

/**
 * Canvas overlay listing the source repos (1:N) that were scanned to infer this
 * project, and — for monorepos — the per-service breakdown. Reads the live canvas
 * store (source repos ride on the project-root node). Hidden when there are none.
 */
export function SourceReposCard() {
	const [open, setOpen] = useState(false);
	const nodes = useCanvasStore((s) => s.nodes);
	const repos = useMemo<SourceRepoRow[]>(() => {
		const project = nodes.find((n) => n.id === PROJECT_NODE_ID);
		const sr =
			project?.data.kind === "project" ? project.data.config.source_repos : undefined;
		return Array.isArray(sr) ? (sr as SourceRepoRow[]) : [];
	}, [nodes]);

	if (repos.length === 0) return null;
	const serviceCount = repos.reduce((n, r) => n + (r.services?.length ?? 0), 0);

	return (
		<div className="absolute bottom-3 left-3 z-10 w-72 border border-border bg-background/95 text-xs shadow-sm backdrop-blur">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="flex w-full items-center justify-between px-2.5 py-1.5 font-medium"
			>
				<span className="flex items-center gap-1.5">
					<GitBranch className="h-3.5 w-3.5" />
					{repos.length} source {repos.length === 1 ? "repo" : "repos"}
					{serviceCount > 0 && (
						<span className="text-muted-foreground">· {serviceCount} services</span>
					)}
				</span>
				<ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
			</button>
			{open && (
				<div className="max-h-64 overflow-y-auto border-t border-border">
					{repos.map((r) => (
						<div key={`${r.repo_url}:${r.scan_path ?? ""}`} className="border-b border-border/60 px-2.5 py-1.5 last:border-0">
							<div className="truncate font-mono" title={r.repo_url}>
								{repoLabel(r.repo_url)}
								{r.ref ? <span className="text-muted-foreground"> @{r.ref}</span> : null}
							</div>
							{(r.services ?? []).map((s) => (
								<div
									key={s.path || "root"}
									className="mt-1 flex items-center gap-1.5 pl-2 text-muted-foreground"
								>
									<Package className="h-3 w-3 shrink-0" />
									<span className="truncate">{s.name}</span>
									{s.runtime ? <span className="opacity-70">· {s.runtime}</span> : null}
									{s.port ? <span className="opacity-70">:{s.port}</span> : null}
								</div>
							))}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
