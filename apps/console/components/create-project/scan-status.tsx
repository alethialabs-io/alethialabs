"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Box, Boxes, Database, GitBranch, KeyRound, Layers, ListOrdered, Radio, Server } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { InferredNeed, ScanProposal } from "@/lib/scanner/schema";
import { Button } from "@repo/ui/button";
import { Spinner } from "@repo/ui/spinner";

import type { ScanResult } from "./use-create-project-reads";

/** One line of the detected stack. */
interface StackItem {
	icon: LucideIcon;
	name: string;
}

const NEED_ICON: Record<InferredNeed["kind"], LucideIcon> = {
	database: Database,
	cache: Layers,
	queue: ListOrdered,
	topic: Radio,
	nosql: Boxes,
	secret: KeyRound,
};

const NEED_LABEL: Record<InferredNeed["kind"], string> = {
	database: "Database",
	cache: "Cache",
	queue: "Queue",
	topic: "Topic",
	nosql: "NoSQL table",
	secret: "Secret",
};

/** A proposal's detected stack: the cluster, each detected workload and each inferred need. */
export function stackItems(proposal: ScanProposal): StackItem[] {
	const items: StackItem[] = [{ icon: Box, name: "Kubernetes cluster" }];
	for (const service of proposal.proposedProject.services ?? []) {
		items.push({ icon: Server, name: service.name });
	}
	for (const need of proposal.stack.needs) {
		items.push({
			icon: NEED_ICON[need.kind],
			name: need.engine ? `${NEED_LABEL[need.kind]} · ${need.engine}` : NEED_LABEL[need.kind],
		});
	}
	return items;
}

/** `owner/repo` from a repository URL, or the URL itself when it does not parse. */
export function repoLabel(url: string): string {
	try {
		return new URL(url).pathname.replace(/^\/+|\.git$/g, "");
	} catch {
		return url;
	}
}

interface ScanStatusProps {
	/** Where the scan is. */
	scan: ScanResult;
	/** The repository the scan reads, as the form holds it (`""` when not known, e.g. a shared link). */
	repoUrl: string;
	/** Re-asks a read that failed. */
	onRetry: () => void;
	/** Drops the scan and goes back to picking a repository. */
	onChangeRepository: () => void;
	/** Creates the project without the scan's design (offered only when the scan did not finish). */
	onCreateWithoutScan: () => void;
	/** True while a create is in flight. */
	pending: boolean;
}

/**
 * Where an import's scan is, in place under the "Import a repository" starting point: running,
 * ready (with the stack it found and the branch it read), waiting for a cloud account, failed,
 * gone, or unreadable — each in its own sentence, each with the one action that helps.
 */
export function ScanStatus({
	scan,
	repoUrl,
	onRetry,
	onChangeRepository,
	onCreateWithoutScan,
	pending,
}: ScanStatusProps) {
	const proposalRepo = scan.status === "READY" ? scan.proposal.proposedProject.source_repos?.[0] : undefined;
	const url = proposalRepo?.repo_url || repoUrl;
	const repo = url ? repoLabel(url) : "your repository";
	const ref = proposalRepo?.ref ?? null;

	const change = (
		<Button type="button" variant="ghost" size="sm" onClick={onChangeRepository} disabled={pending}>
			Change repository
		</Button>
	);

	return (
		<div className="space-y-3 border border-border bg-card p-3" data-testid="scan-status">
			<div className="flex items-center gap-3">
				<GitBranch aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
				<div className="min-w-0 flex-1">
					<div className="truncate font-mono text-ui-md text-foreground">{repo}</div>
					{ref ? (
						<div className="font-mono text-ui-2xs text-muted-foreground">branch · {ref}</div>
					) : null}
				</div>
				{change}
			</div>
			<ScanBody scan={scan} repo={repo} onRetry={onRetry} onCreateWithoutScan={onCreateWithoutScan} pending={pending} />
		</div>
	);
}

/** The scan's state, below the repository line. */
function ScanBody({
	scan,
	repo,
	onRetry,
	onCreateWithoutScan,
	pending,
}: {
	scan: ScanResult;
	repo: string;
	onRetry: () => void;
	onCreateWithoutScan: () => void;
	pending: boolean;
}) {
	switch (scan.status) {
		case "PENDING":
			return (
				<p role="status" className="flex items-center gap-2 text-ui-sm text-muted-foreground">
					<Spinner />
					Scanning {repo}. This usually takes under a minute; you can name the project meanwhile.
				</p>
			);
		case "READY": {
			const items = stackItems(scan.proposal);
			return (
				<div className="space-y-2">
					<p className="text-ui-sm text-muted-foreground">
						Found {items.length} {items.length === 1 ? "component" : "components"}. They open on
						the canvas as a design to review; nothing is provisioned.
					</p>
					<ul className="flex flex-wrap gap-1.5" aria-label="Detected stack">
						{items.map((item, index) => {
							const Icon = item.icon;
							return (
								<li
									key={`${item.name}-${index}`}
									className="inline-flex items-center gap-1.5 border border-border px-2 py-1 text-ui-xs text-foreground"
								>
									<Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
									{item.name}
								</li>
							);
						})}
					</ul>
				</div>
			);
		}
		case "NEEDS_SETUP":
			return (
				<p role="status" className="text-ui-sm text-muted-foreground">
					Scanned. Connect a cloud account below and the design is placed on it.
				</p>
			);
		case "FAILED":
			return (
				<div className="space-y-2" role="alert">
					<p className="text-ui-sm text-foreground">
						The scan did not finish ({scan.jobStatus.toLowerCase()}). Scan again, or create an empty
						project and design it yourself.
					</p>
					<Button type="button" variant="outline" size="sm" onClick={onCreateWithoutScan} disabled={pending}>
						Create without the scan
					</Button>
				</div>
			);
		case "NOT_FOUND":
			return (
				<p role="alert" className="text-ui-sm text-foreground">
					That scan was not found. Pick the repository again to start a new one.
				</p>
			);
		case "ERROR":
			return (
				<div className="flex items-center gap-3" role="alert">
					<p className="text-ui-sm text-foreground">We could not check on the scan.</p>
					<Button type="button" variant="outline" size="sm" onClick={onRetry}>
						Try again
					</Button>
				</div>
			);
	}
}
