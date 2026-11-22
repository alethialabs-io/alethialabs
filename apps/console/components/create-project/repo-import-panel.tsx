"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Repository } from "@/app/server/actions/git/types";
import { startRepoScan } from "@/app/server/actions/scanner";
import { RepositorySelector } from "@/components/repository-selector";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import type { GitProviderAvailability } from "@/lib/connectors/git-providers";
import { orpc } from "@/lib/rpc/client";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { Spinner } from "@repo/ui/spinner";

import { useLinkedGitProviders } from "./use-create-project-reads";

interface RepoImportPanelProps {
	/** The picked repository's URL; `""` when none is picked. Held by the create form (and its draft). */
	repoUrl: string;
	/** The picked repository's branch; `""` for the default branch. */
	gitRef: string;
	/** A repository was picked (or cleared): its URL and default branch. */
	onRepository: (repoUrl: string, ref: string) => void;
	/** The scan was queued: its job id, which the create screen puts in `?scan=`. */
	onScanned: (jobId: string) => void;
	/** Which git providers this instance can link (server-computed); unconfigured ones render disabled. */
	providerAvailability: GitProviderAvailability;
}

/**
 * The "Import a repository" starting point on the create screen: pick a git repository, queue a
 * scan, and hand the job id back, so the screen follows the scan in place (`?scan=<jobId>`). Reuses
 * {@link RepositorySelector} and {@link startRepoScan}.
 *
 * The selector is handed the caller's linked providers, which the route prefetched, so its first
 * render is already the repository row (or, with nothing linked, the Link panel), not a swap (F034).
 */
export function RepoImportPanel({
	repoUrl,
	gitRef,
	onRepository,
	onScanned,
	providerAvailability,
}: RepoImportPanelProps) {
	const linked = useLinkedGitProviders();
	// The scan through the mutation contract: pending state, a double-submit guard, a readable refusal
	// (an AI budget or a job quota). A new job joins the shell's job feed and the jobs list.
	const scan = useActionMutation(startRepoScan, {
		invalidates: [orpc.workspace.recentJobs.key(), orpc.workspace.jobs.key(), orpc.jobs.page.key()],
		onSuccess: ({ jobId }) => onScanned(jobId),
	});

	/** Records the picked repository's URL and default branch (the scan ref). */
	const onRepositorySelect = (repo: Repository) => {
		onRepository(repo.url, repo.default_branch || "");
	};

	/** Queues the scan of the picked repository. */
	const onScan = () => {
		if (!repoUrl || scan.isPending) return;
		scan.mutate({ repoUrl, ...(gitRef ? { ref: gitRef } : {}) });
	};

	return (
		<div className="space-y-3">
			<RepositorySelector
				value={repoUrl || undefined}
				onChange={(value) => onRepository(value, "")}
				onRepositorySelect={onRepositorySelect}
				label=""
				placeholder="Select a repository to import…"
				providerAvailability={providerAvailability}
				linkedProviders={linked.data}
			/>
			<div className="flex items-center justify-between gap-3">
				<span className="truncate font-mono text-ui-2xs uppercase tracking-wider text-muted-foreground">
					{repoUrl ? (gitRef ? `branch · ${gitRef}` : "default branch") : "no repository selected"}
				</span>
				<DisabledReason reason={repoUrl ? null : "Pick a repository first."}>
					<Button type="button" variant="outline" onClick={onScan} disabled={scan.isPending}>
						{scan.isPending ? <Spinner /> : null}
						Scan repository
					</Button>
				</DisabledReason>
			</div>
		</div>
	);
}
