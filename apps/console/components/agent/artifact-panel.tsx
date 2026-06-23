"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { getRegionPrices } from "@/app/server/actions/pricing";
import { getPlanResult } from "@/app/server/actions/jobs";
import { getSpec } from "@/app/server/actions/specs";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getProvider, type CloudProviderSlug } from "@/lib/cloud-providers";
import { type CostItem, computeCostItems } from "@/lib/cost/compute-cost-items";
import { type CostSummary, parseCostBreakdown } from "@/lib/plan/parse-cost";
import { type PlanSummary, parsePlanJSON } from "@/lib/plan/parse-plan";
import {
	type ArtifactTab,
	useArtifactStore,
} from "@/lib/stores/use-artifact-store";
import { useJobLogStream } from "@/hooks/use-job-log-stream";
import { cn } from "@/lib/utils";

type SpecDetail = Awaited<ReturnType<typeof getSpec>>;

interface PlanState {
	status: string;
	error: string | null;
	planSummary: PlanSummary | null;
	costSummary: CostSummary | null;
}

/** Narrow a free-form provider string to a known slug (no casts). */
function toSlug(p: string): CloudProviderSlug {
	return p === "gcp" || p === "azure" ? p : "aws";
}

/**
 * The agent's right-hand artifact panel — Config / Plan / Cost / Logs for the
 * active spec/job (from `useArtifactStore`). All four tabs read existing server
 * actions + pure parsers; Logs streams over the shared `useJobLogStream` SSE.
 * Grayscale/squared; sheds below `xl` (matches the design).
 */
export function ArtifactPanel() {
	const artifact = useArtifactStore((s) => s.artifact);
	const tab = useArtifactStore((s) => s.tab);
	const setTab = useArtifactStore((s) => s.setTab);
	const close = useArtifactStore((s) => s.close);

	const specId = artifact?.specId;
	const jobId = artifact?.jobId;

	const [spec, setSpec] = useState<SpecDetail | null>(null);
	const [cost, setCost] = useState<{ items: CostItem[]; total: number } | null>(
		null,
	);
	const [plan, setPlan] = useState<PlanState | null>(null);
	const { logs } = useJobLogStream(jobId ?? null);

	// Load the spec + compute its cost.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			if (!specId) {
				if (!cancelled) {
					setSpec(null);
					setCost(null);
				}
				return;
			}
			const detail = await getSpec(specId);
			if (cancelled) return;
			setSpec(detail);
			const region = detail.spec.region;
			const prices = region ? await getRegionPrices(region) : null;
			if (cancelled) return;
			const c = detail.components.cluster;
			const n = detail.components.network;
			const meta = getProvider(toSlug(detail.cloudProvider));
			setCost(
				computeCostItems(
					{
						instanceTypes: c?.instance_types ?? [],
						nodeDesiredSize: c?.node_desired_size ?? 2,
						singleNatGateway: n?.single_nat_gateway ?? true,
						databases: (detail.components.databases ?? []).map((d) => ({
							name: d.name,
							min_capacity: d.min_capacity,
							max_capacity: d.max_capacity,
						})),
						caches: (detail.components.caches ?? []).map((ch) => ({
							name: ch.name,
							node_type: ch.node_type,
							num_cache_nodes: ch.num_cache_nodes,
						})),
						cloudfrontWaf: false,
						applicationWaf: detail.components.dns?.waf_enabled ?? false,
						nosqlCount: (detail.components.nosql_tables ?? []).length,
						secretsCount: (detail.components.secrets ?? []).length,
					},
					prices,
					{
						clusterService: meta.clusterService,
						secretsService: meta.secretsService,
					},
				),
			);
		})();
		return () => {
			cancelled = true;
		};
	}, [specId]);

	// Load the job's plan result.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			if (!jobId) {
				if (!cancelled) setPlan(null);
				return;
			}
			const r = await getPlanResult(jobId);
			if (cancelled) return;
			const meta = r.execution_metadata;
			setPlan({
				status: r.status,
				error: r.error_message,
				planSummary: meta?.plan_result ? parsePlanJSON(meta.plan_result) : null,
				costSummary: meta?.cost_breakdown
					? parseCostBreakdown(meta.cost_breakdown)
					: null,
			});
		})();
		return () => {
			cancelled = true;
		};
	}, [jobId]);

	if (!artifact) return null;

	const title = spec?.spec.project_name ?? (jobId ? `Job ${jobId.slice(0, 8)}` : "Artifact");

	return (
		<aside className="hidden w-[420px] flex-none flex-col border-l border-border bg-card xl:flex">
			<header className="flex h-[52px] flex-none items-center justify-between gap-2 border-b border-border px-4">
				<span className="truncate text-sm font-medium">{title}</span>
				<button
					type="button"
					onClick={close}
					aria-label="Close panel"
					className="flex h-7 w-7 flex-none items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
				>
					<X className="h-4 w-4" />
				</button>
			</header>

			<Tabs
				value={tab}
				onValueChange={(v) => {
					if (v === "config" || v === "plan" || v === "cost" || v === "logs")
						setTab(v as ArtifactTab);
				}}
				className="flex min-h-0 flex-1 flex-col gap-0"
			>
				<TabsList className="h-auto justify-start rounded-none border-b border-border bg-transparent px-2 py-1.5">
					<TabsTrigger value="config" className="rounded-none text-xs">
						Config
					</TabsTrigger>
					<TabsTrigger value="plan" className="rounded-none text-xs">
						Plan
					</TabsTrigger>
					<TabsTrigger value="cost" className="rounded-none text-xs">
						Cost
					</TabsTrigger>
					<TabsTrigger value="logs" className="rounded-none text-xs">
						Logs
					</TabsTrigger>
				</TabsList>

				<div className="min-h-0 flex-1">
					<TabsContent value="config" className="m-0 h-full">
						<ScrollArea className="h-full">
							<div className="p-4">
								<ConfigPane spec={spec} />
							</div>
						</ScrollArea>
					</TabsContent>
					<TabsContent value="plan" className="m-0 h-full">
						<ScrollArea className="h-full">
							<div className="p-4">
								<PlanPane plan={plan} jobId={jobId} />
							</div>
						</ScrollArea>
					</TabsContent>
					<TabsContent value="cost" className="m-0 h-full">
						<ScrollArea className="h-full">
							<div className="p-4">
								<CostPane cost={cost} />
							</div>
						</ScrollArea>
					</TabsContent>
					<TabsContent value="logs" className="m-0 h-full">
						<ScrollArea className="h-full">
							<div className="p-4">
								{!jobId ? (
									<Empty text="Open a job to stream its logs." />
								) : logs.length === 0 ? (
									<Empty text="Waiting for logs…" />
								) : (
									<div className="space-y-0.5 font-mono text-[11px] leading-relaxed">
										{logs.map((l) => (
											<div
												key={l.id}
												className={cn(
													"whitespace-pre-wrap",
													l.stream_type === "STDERR"
														? "text-foreground"
														: "text-muted-foreground",
												)}
											>
												{l.log_chunk}
											</div>
										))}
									</div>
								)}
							</div>
						</ScrollArea>
					</TabsContent>
				</div>
			</Tabs>
		</aside>
	);
}

function Empty({ text }: { text: string }) {
	return <p className="py-8 text-center text-xs text-muted-foreground">{text}</p>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div>
			<div className="vx-eyebrow pb-1 text-[9px]">{title}</div>
			<div className="border border-border px-3">{children}</div>
		</div>
	);
}

function Row({ k, v }: { k: string; v: ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-3 border-b border-border py-2 font-mono text-[11px] last:border-0">
			<span className="text-muted-foreground">{k}</span>
			<span className="truncate text-right text-foreground">{v || "—"}</span>
		</div>
	);
}

function ListSection({
	title,
	items,
}: {
	title: string;
	items: Array<{ name: string; detail?: string }>;
}) {
	if (items.length === 0) return null;
	return (
		<Section title={title}>
			{items.map((i) => (
				<Row key={i.name} k={i.name} v={i.detail ?? ""} />
			))}
		</Section>
	);
}

function ConfigPane({ spec }: { spec: SpecDetail | null }) {
	if (!spec) return <Empty text="Loading…" />;
	const { components, cloudProvider } = spec;
	const c = components.cluster;
	const n = components.network;
	const dns = components.dns;
	return (
		<div className="space-y-4">
			<div className="border border-border bg-muted/40 p-3">
				<div className="text-sm font-medium">{spec.spec.project_name}</div>
				<div className="vx-eyebrow mt-1 text-[9px]">
					{cloudProvider} · {spec.spec.region ?? "—"} ·{" "}
					{spec.spec.environment_stage}
				</div>
			</div>

			{c && (
				<Section title="Cluster">
					<Row k="version" v={c.cluster_version} />
					<Row k="nodes" v={`${c.node_min_size}–${c.node_max_size} (desired ${c.node_desired_size})`} />
					<Row k="instances" v={(c.instance_types ?? []).join(", ")} />
				</Section>
			)}

			{n && (
				<Section title="Network">
					<Row k="provision" v={n.provision_network ? "new" : "existing"} />
					<Row k="cidr" v={n.cidr_block} />
					<Row k="nat" v={n.single_nat_gateway ? "single" : "per-AZ"} />
				</Section>
			)}

			{dns?.enabled && (
				<Section title="DNS">
					<Row k="domain" v={dns.domain_name} />
					<Row k="cert" v={dns.managed_certificate ? "managed" : "none"} />
					<Row k="waf" v={dns.waf_enabled ? "on" : "off"} />
				</Section>
			)}

			<ListSection
				title="Databases"
				items={(components.databases ?? []).map((d) => ({
					name: d.name,
					detail: d.engine ?? undefined,
				}))}
			/>
			<ListSection
				title="Caches"
				items={(components.caches ?? []).map((ch) => ({
					name: ch.name,
					detail: [ch.engine, ch.node_type].filter(Boolean).join(" · "),
				}))}
			/>
			<ListSection
				title="Queues"
				items={(components.queues ?? []).map((q) => ({ name: q.name }))}
			/>
			<ListSection
				title="Topics"
				items={(components.topics ?? []).map((t) => ({ name: t.name }))}
			/>
			<ListSection
				title="NoSQL"
				items={(components.nosql_tables ?? []).map((t) => ({ name: t.name }))}
			/>
			<ListSection
				title="Secrets"
				items={(components.secrets ?? []).map((s) => ({ name: s.name }))}
			/>
		</div>
	);
}

function CostPane({ cost }: { cost: { items: CostItem[]; total: number } | null }) {
	if (!cost) return <Empty text="Open a spec to estimate its cost." />;
	return (
		<div>
			<div className="space-y-1.5">
				{cost.items.map((item) => (
					<div
						key={item.label}
						className="flex items-center justify-between text-xs"
					>
						<div className="flex min-w-0 items-center gap-1.5">
							<span className="truncate text-muted-foreground">{item.label}</span>
							{item.detail && (
								<Badge
									variant="outline"
									className="shrink-0 rounded-none px-1 py-0 text-[9px]"
								>
									{item.detail}
								</Badge>
							)}
						</div>
						<span className="ml-2 shrink-0 font-mono text-foreground">
							${item.cost.toFixed(0)}
						</span>
					</div>
				))}
			</div>
			<div className="mt-3 flex items-center justify-between border-t border-border pt-3">
				<span className="text-sm font-medium">Total</span>
				<span className="font-mono text-sm font-semibold">
					~${cost.total.toFixed(0)}/mo
				</span>
			</div>
		</div>
	);
}

function CountPill({ n, label }: { n: number; label: string }) {
	return (
		<div className="border border-border px-2.5 py-1.5 text-center">
			<div className="font-mono text-base font-semibold">{n}</div>
			<div className="vx-eyebrow text-[8px]">{label}</div>
		</div>
	);
}

function PlanPane({
	plan,
	jobId,
}: {
	plan: PlanState | null;
	jobId: string | undefined;
}) {
	if (!jobId) return <Empty text="Open a job to see its plan." />;
	if (!plan) return <Empty text="Loading…" />;
	if (!plan.planSummary)
		return (
			<Empty
				text={
					plan.error
						? `Plan failed: ${plan.error}`
						: "No plan output yet — run a plan (deploy flow coming soon)."
				}
			/>
		);
	const { counts, resources } = plan.planSummary;
	return (
		<div className="space-y-3">
			<div className="flex gap-2">
				<CountPill n={counts.create} label="add" />
				<CountPill n={counts.update} label="change" />
				<CountPill n={counts.delete} label="destroy" />
				{counts.replace > 0 && <CountPill n={counts.replace} label="replace" />}
			</div>
			{plan.costSummary?.totalMonthlyCost != null && (
				<div className="font-mono text-xs text-muted-foreground">
					~${plan.costSummary.totalMonthlyCost.toFixed(0)}/mo
				</div>
			)}
			<div className="divide-y divide-border border border-border">
				{resources.map((r) => (
					<div
						key={r.address}
						className="flex items-center justify-between gap-2 px-3 py-1.5 font-mono text-[11px]"
					>
						<span className="truncate text-foreground">
							{r.displayName} · {r.name}
						</span>
						<span className="flex-none text-muted-foreground">{r.action}</span>
					</div>
				))}
			</div>
		</div>
	);
}
