"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ArrowRight, GitBranch, Loader2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import type { Repository } from "@/app/server/actions/git/types";
import { startRepoScan } from "@/app/server/actions/scanner";
import { RepositorySelector } from "@/components/repository-selector";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import type { GitProviderAvailability } from "@/lib/connectors/git-providers";
import { orpc } from "@/lib/rpc/client";
import { cn } from "@repo/ui/utils";
import { Button } from "@repo/ui/button";
import { SectionHeading } from "@repo/ui/section-heading";

import { useLinkedGitProviders } from "./use-create-project-reads";

interface RepoImportPanelProps {
	/** Optional wrapper class so the front door can slot the panel into its layout. */
	className?: string;
	/** Which git providers this instance can link (server-computed); unconfigured ones render disabled. */
	providerAvailability: GitProviderAvailability;
}

/**
 * The first-class "Import a repository" on-ramp for `~/new`: pick a git repo, queue a scan, then
 * hand off to the Configure screen at `?scan=<jobId>`, which follows the scan live. Reuses
 * {@link RepositorySelector} (git-provider → repo pick) and {@link startRepoScan} (queues an
 * ANALYZE_REPO job). No agent involved: this exposes the north-star motion as a button.
 *
 * ONE LAYOUT THROUGH LOAD (F034). The selector is handed the caller's linked providers, which the
 * route prefetched on the server, so its first render — the server render included — is already the
 * provider + repository row (or, with nothing linked, the Link panel). It used to render the Link
 * panel first, swap to a skeleton, then to the row. Only when the prefetch did not land does the
 * selector read the list itself, from its loading row.
 */
export function RepoImportPanel({ className, providerAvailability }: RepoImportPanelProps) {
	const router = useRouter();
	const pathname = usePathname();
	const [repoUrl, setRepoUrl] = useState<string | undefined>(undefined);
	// The repo's default branch, passed as the scan ref so the runner clones the right head.
	const [ref, setRef] = useState<string | undefined>(undefined);
	const linked = useLinkedGitProviders();
	// The scan through the mutation contract: pending state, a double-submit guard, a readable
	// refusal (an AI budget or a job quota) instead of a digest. A new job joins the shell's job feed
	// and the jobs list, so those keys refresh with it.
	const scan = useActionMutation(startRepoScan, {
		invalidates: [orpc.workspace.recentJobs.key(), orpc.workspace.jobs.key(), orpc.jobs.page.key()],
		onSuccess: ({ jobId }) => router.push(`${pathname}?scan=${jobId}`),
	});
	// Busy from the click until Configure replaces this screen — a success is a navigation in flight.
	const scanning = scan.isPending || scan.isSuccess;

	/** Records the picked repo's URL + default branch (the scan ref). */
	const onRepositorySelect = (repo: Repository) => {
		setRepoUrl(repo.url);
		setRef(repo.default_branch || undefined);
	};

	/** Queues the scan and hands off to the `?scan=` Configure screen on the same page. */
	const onScan = () => {
		if (!repoUrl || scanning) return;
		scan.mutate({ repoUrl, ...(ref ? { ref } : {}) });
	};

	return (
		<section className={cn("space-y-0", className)}>
			<div className="rounded-xl border border-border bg-card shadow-sm">
				<div className="flex items-start gap-3 p-4 pb-3">
					<span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border border-border text-muted-foreground">
						<GitBranch className="size-4" />
					</span>
					<SectionHeading
						className="min-w-0 flex-1"
						title="Import a repository"
						description="Scan a git repo — Alethia infers the stack and opens it on the canvas to review before you provision."
					/>
				</div>
				<div className="space-y-3 px-4 pb-4">
					<RepositorySelector
						value={repoUrl}
						onChange={(v) => setRepoUrl(v || undefined)}
						onRepositorySelect={onRepositorySelect}
						label=""
						placeholder="Select a repository to import…"
						providerAvailability={providerAvailability}
						linkedProviders={linked.data}
					/>
					<div className="flex items-center justify-between gap-3">
						<span className="truncate font-mono text-ui-2xs uppercase tracking-wider text-muted-foreground">
							{repoUrl
								? ref
									? `branch · ${ref}`
									: "default branch"
								: "no repository selected"}
						</span>
						<Button
							type="button"
							onClick={onScan}
							disabled={!repoUrl || scanning}
						>
							{scanning ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<>
									Scan repository
									<ArrowRight className="size-4" />
								</>
							)}
						</Button>
					</div>
				</div>
			</div>
		</section>
	);
}
