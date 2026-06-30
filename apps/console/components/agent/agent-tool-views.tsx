"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ToolUIPart } from "ai";
import { z } from "zod";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";
import { useArtifactStore } from "@/lib/stores/use-artifact-store";
import { cn } from "@repo/ui/utils";
import { AgentToolCard } from "./agent-chat";

/** Tool result types this module renders specially (tables / chips). */
export const TOOL_VIEW_TYPES = new Set<string>([
	"tool-list_projects",
	"tool-list_jobs",
	"tool-list_clusters",
	"tool-list_connectors",
	"tool-cidr_for_hosts",
	"tool-list_services",
	"tool-list_service_options",
]);

const str = z.string().nullish();
const projectsOut = z.object({
	projects: z.array(
		z.object({ id: z.string(), name: str, environment: str, region: str, status: str }),
	),
});
const jobsOut = z.object({
	jobs: z.array(
		z.object({ id: z.string(), type: str, project: str, provider: str, status: str }),
	),
});
const clustersOut = z.object({
	clusters: z.array(
		z.object({ id: z.string(), name: str, region: str, provider: str, status: str }),
	),
});
const connectorsOut = z.object({
	connectors: z.array(
		z.object({ slug: z.string(), name: str, category: str, status: str, connected: z.boolean().nullish() }),
	),
});
const cidrOut = z.object({ cidr: z.string(), totalAddresses: z.number().nullish() });

/** Compact one-line tool result. */
function ToolChip({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex w-fit items-center gap-2 border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
			<span className="h-1.5 w-1.5 flex-none rounded-full bg-foreground" />
			<span className="text-foreground">{label}</span>
			<span>·</span>
			<span>{value}</span>
		</div>
	);
}

function Status({ v }: { v: string | null | undefined }) {
	return (
		<span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
			<span className="h-1.5 w-1.5 flex-none rounded-full bg-muted-foreground/70" />
			{v ?? "—"}
		</span>
	);
}

const TH = "vx-eyebrow h-auto py-2 text-[9px]";
const TD = "py-1.5 text-[12px]";

function Shell({ children }: { children: React.ReactNode }) {
	return <div className="overflow-hidden border border-border">{children}</div>;
}

/**
 * Polished tool-result renderings for the agent transcript — inline tables for the
 * list_* reads (projects/jobs clickable → artifact panel) and compact chips for the
 * catalog/CIDR tools. Falls back to the default tool card for anything else.
 */
export function ToolView({ part }: { part: ToolUIPart }) {
	const open = useArtifactStore((s) => s.open);
	if (part.state !== "output-available") return <AgentToolCard part={part} />;

	switch (part.type) {
		case "tool-cidr_for_hosts": {
			const p = cidrOut.safeParse(part.output);
			return p.success ? (
				<ToolChip
					label="cidr_for_hosts"
					value={`${p.data.cidr}${p.data.totalAddresses ? ` · ${p.data.totalAddresses} IPs` : ""}`}
				/>
			) : (
				<AgentToolCard part={part} />
			);
		}
		case "tool-list_services":
			return <ToolChip label="list_services" value="catalog loaded" />;
		case "tool-list_service_options":
			return <ToolChip label="list_service_options" value="options loaded" />;

		case "tool-list_projects": {
			const p = projectsOut.safeParse(part.output);
			if (!p.success) return <AgentToolCard part={part} />;
			return (
				<Shell>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className={TH}>Project</TableHead>
								<TableHead className={TH}>Env</TableHead>
								<TableHead className={TH}>Region</TableHead>
								<TableHead className={TH}>Status</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{p.data.projects.map((s) => (
								<TableRow
									key={s.id}
									onClick={() => open({ projectId: s.id }, "config")}
									className="cursor-pointer"
								>
									<TableCell className={cn(TD, "font-medium")}>{s.name ?? "—"}</TableCell>
									<TableCell className={TD}>{s.environment ?? "—"}</TableCell>
									<TableCell className={cn(TD, "font-mono")}>{s.region ?? "—"}</TableCell>
									<TableCell className={TD}>
										<Status v={s.status} />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</Shell>
			);
		}

		case "tool-list_jobs": {
			const p = jobsOut.safeParse(part.output);
			if (!p.success) return <AgentToolCard part={part} />;
			return (
				<Shell>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className={TH}>Type</TableHead>
								<TableHead className={TH}>Project</TableHead>
								<TableHead className={TH}>Status</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{p.data.jobs.map((j) => (
								<TableRow
									key={j.id}
									onClick={() => open({ jobId: j.id }, "logs")}
									className="cursor-pointer"
								>
									<TableCell className={cn(TD, "font-mono")}>{j.type ?? "—"}</TableCell>
									<TableCell className={TD}>{j.project ?? "—"}</TableCell>
									<TableCell className={TD}>
										<Status v={j.status} />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</Shell>
			);
		}

		case "tool-list_clusters": {
			const p = clustersOut.safeParse(part.output);
			if (!p.success) return <AgentToolCard part={part} />;
			return (
				<Shell>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className={TH}>Cluster</TableHead>
								<TableHead className={TH}>Region</TableHead>
								<TableHead className={TH}>Cloud</TableHead>
								<TableHead className={TH}>Status</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{p.data.clusters.map((c) => (
								<TableRow key={c.id}>
									<TableCell className={cn(TD, "font-medium")}>{c.name ?? "—"}</TableCell>
									<TableCell className={cn(TD, "font-mono")}>{c.region ?? "—"}</TableCell>
									<TableCell className={cn(TD, "font-mono")}>{c.provider ?? "—"}</TableCell>
									<TableCell className={TD}>
										<Status v={c.status} />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</Shell>
			);
		}

		case "tool-list_connectors": {
			const p = connectorsOut.safeParse(part.output);
			if (!p.success) return <AgentToolCard part={part} />;
			return (
				<Shell>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className={TH}>Connector</TableHead>
								<TableHead className={TH}>Category</TableHead>
								<TableHead className={TH}>Connected</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{p.data.connectors.map((c) => (
								<TableRow key={c.slug}>
									<TableCell className={cn(TD, "font-medium")}>{c.name ?? c.slug}</TableCell>
									<TableCell className={cn(TD, "font-mono")}>{c.category ?? "—"}</TableCell>
									<TableCell className={TD}>
										<Status v={c.connected ? "connected" : "not connected"} />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</Shell>
			);
		}

		default:
			return <AgentToolCard part={part} />;
	}
}
