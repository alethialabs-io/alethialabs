"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { getRegionPrices } from "@/app/server/actions/pricing";
import { getGitopsDeployStatus } from "@/app/server/actions/gitops-status";
import { getPlanResult } from "@/app/server/actions/jobs";
import { getProject } from "@/app/server/actions/projects";
import { DeployPane } from "@/components/agent/deploy-pane";
import type { GitopsDeployStatus } from "@/lib/gitops/deploy-status";
import { Badge } from "@repo/ui/badge";
import { ScrollArea } from "@repo/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/tabs";
import { getProvider, type CloudProviderSlug } from "@/lib/cloud-providers";
import { type CostItem, computeCostItems } from "@/lib/cost/compute-cost-items";
import { type CostSummary, parseCostBreakdown } from "@/lib/plan/parse-cost";
import { type PlanSummary, parsePlanJSON } from "@/lib/plan/parse-plan";
import { useArtifactStore } from "@/lib/stores/use-artifact-store";
import { useJobLogStream } from "@/hooks/use-job-log-stream";
import type {
	SignedReceipt,
	VerifyReport,
	VerifyStatus,
} from "@/types/jsonb.types";
import { cn } from "@repo/ui/utils";

type ProjectDetail = Awaited<ReturnType<typeof getProject>>;

interface PlanState {
	status: string;
	error: string | null;
	planSummary: PlanSummary | null;
	costSummary: CostSummary | null;
	verifyReport: VerifyReport | null;
	receipt: SignedReceipt | null;
}

/** Narrow a free-form provider string to a known slug (no casts). */
function toSlug(p: string): CloudProviderSlug {
	return p === "gcp" || p === "azure" ? p : "aws";
}

/**
 * The agent's generative-UI split pane — Config / Plan / Deploy / Cost / Logs for the
 * active project/job (from `useArtifactStore`). All tabs read existing server
 * actions + pure parsers; Logs streams over the shared `useJobLogStream` SSE.
 * Grayscale/squared; fills the resizable split column the Elench modal gives it,
 * and self-hides (returns null) when no artifact is open.
 */
export function ArtifactPanel() {
	const artifact = useArtifactStore((s) => s.artifact);
	const tab = useArtifactStore((s) => s.tab);
	const setTab = useArtifactStore((s) => s.setTab);
	const close = useArtifactStore((s) => s.close);

	const projectId = artifact?.projectId;
	const jobId = artifact?.jobId;

	const [project, setProject] = useState<ProjectDetail | null>(null);
	const [cost, setCost] = useState<{ items: CostItem[]; total: number } | null>(
		null,
	);
	const [plan, setPlan] = useState<PlanState | null>(null);
	const [deploy, setDeploy] = useState<GitopsDeployStatus | null>(null);
	const { logs } = useJobLogStream(jobId ?? null);

	// Load the project + compute its cost.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			if (!projectId) {
				if (!cancelled) {
					setProject(null);
					setCost(null);
				}
				return;
			}
			const detail = await getProject(projectId);
			if (cancelled) return;
			setProject(detail);
			const region = detail.project.region;
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
	}, [projectId]);

	// Load the environment's GitOps deploy status (#574) — same useEffect+server-action
	// pattern as the other panes; refetched whenever the artifact's project changes.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			if (!projectId) {
				if (!cancelled) setDeploy(null);
				return;
			}
			const status = await getGitopsDeployStatus(projectId).catch(() => null);
			if (!cancelled) setDeploy(status);
		})();
		return () => {
			cancelled = true;
		};
	}, [projectId]);

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
				verifyReport: meta?.verify_result ?? null,
				receipt: meta?.verify_receipt ?? null,
			});
		})();
		return () => {
			cancelled = true;
		};
	}, [jobId]);

	if (!artifact) return null;

	// Config/Cost need a project; Plan/Logs need a job. The tabs are shown only for
	// what the artifact actually carries.
	const hasProject = !!projectId;
	const hasJob = !!jobId;

	const title =
		project?.project.project_name ??
		(jobId ? `Job ${jobId.slice(0, 8)}` : "Artifact");

	return (
		<aside className="flex h-full w-full flex-col bg-card">
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
					if (
						v === "config" ||
						v === "plan" ||
						v === "deploy" ||
						v === "cost" ||
						v === "logs"
					)
						setTab(v);
				}}
				className="flex min-h-0 flex-1 flex-col gap-0"
			>
				<TabsList className="h-auto justify-start rounded-none border-b border-border bg-transparent px-2 py-1.5">
					{hasProject && (
						<TabsTrigger value="config" className="rounded-none text-xs">
							Config
						</TabsTrigger>
					)}
					{hasJob && (
						<TabsTrigger value="plan" className="rounded-none text-xs">
							Plan
						</TabsTrigger>
					)}
					{hasProject && (
						<TabsTrigger value="deploy" className="rounded-none text-xs">
							Deploy
						</TabsTrigger>
					)}
					{hasProject && (
						<TabsTrigger value="cost" className="rounded-none text-xs">
							Cost
						</TabsTrigger>
					)}
					{hasJob && (
						<TabsTrigger value="logs" className="rounded-none text-xs">
							Logs
						</TabsTrigger>
					)}
				</TabsList>

				<div className="min-h-0 flex-1">
					<TabsContent value="config" className="m-0 h-full">
						<ScrollArea className="h-full">
							<div className="p-4">
								<ConfigPane project={project} />
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
					<TabsContent value="deploy" className="m-0 h-full">
						<ScrollArea className="h-full">
							<div className="p-4">
								{!projectId ? (
									<Empty text="Open a project to see its GitOps status." />
								) : (
									<DeployPane status={deploy} />
								)}
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

function ConfigPane({ project }: { project: ProjectDetail | null }) {
	if (!project) return <Empty text="Loading…" />;
	const { components, cloudProvider } = project;
	const c = components.cluster;
	const n = components.network;
	const dns = components.dns;
	return (
		<div className="space-y-4">
			<div className="border border-border bg-muted/40 p-3">
				<div className="text-sm font-medium">{project.project.project_name}</div>
				<div className="vx-eyebrow mt-1 text-[9px]">
					{cloudProvider} · {project.project.region ?? "—"} ·{" "}
					{project.project.environment_stage}
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
	if (!cost) return <Empty text="Open a project to estimate its cost." />;
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

/** Verdict/status → grayscale Badge variant (no color; fail is solid, pass is outline). */
function statusBadgeVariant(s: VerifyStatus): "default" | "outline" | "secondary" {
	if (s === "fail") return "default";
	if (s === "pass") return "outline";
	return "secondary";
}

const VERDICT_LABEL: Record<VerifyStatus, string> = {
	pass: "passed",
	fail: "blocked",
	warn: "warnings",
	not_evaluable: "not evaluable",
};

/**
 * The verification gate's per-control result (elench). Renders the overall verdict,
 * each control's status + findings, and — importantly — the coverage notes that say
 * what the gate could NOT inspect, so a `not_evaluable` is never mistaken for a pass.
 */
export function VerifyBlock({ report }: { report: VerifyReport }) {
	return (
		<Section title="Verification">
			<div className="flex items-center justify-between border-b border-border py-2">
				<span className="font-mono text-[10px] text-muted-foreground">
					{report.provider} · {report.catalog_version}
				</span>
				<Badge
					variant={statusBadgeVariant(report.verdict)}
					className="rounded-none text-[9px] uppercase"
				>
					{VERDICT_LABEL[report.verdict]}
				</Badge>
			</div>
			{report.controls.map((c) => (
				<div key={c.id} className="border-b border-border py-2 last:border-0">
					<div className="flex items-center justify-between gap-2">
						<span className="font-mono text-[11px] text-foreground">{c.id}</span>
						<Badge
							variant={statusBadgeVariant(c.status)}
							className="rounded-none text-[9px] uppercase"
						>
							{c.status.replace("_", " ")}
						</Badge>
					</div>
					<div className="text-[10px] text-muted-foreground">
						{c.title}
						{c.frameworks?.length ? ` · ${c.frameworks.join(", ")}` : ""}
					</div>
					{(c.findings ?? []).map((f, i) => (
						<div
							key={`${f.address}-${i}`}
							className="mt-1 font-mono text-[10px] text-foreground"
						>
							<span className="text-muted-foreground">{f.address}</span> — {f.message}
						</div>
					))}
					{c.coverage && (
						<div className="mt-1 text-[10px] italic text-muted-foreground">
							coverage: {c.coverage}
						</div>
					)}
				</div>
			))}
		</Section>
	);
}

/**
 * The signed evidence receipt (elench): shows whether the receipt is signed, the
 * plan hash it is bound to, any recorded exception, and a download of the raw
 * receipt JSON (which can be verified offline against the signing public key).
 */
function ReceiptBlock({ receipt, jobId }: { receipt: SignedReceipt; jobId: string }) {
	const signed = receipt.algorithm === "ed25519";
	const body = receipt.receipt;
	const download = () => {
		const blob = new Blob([JSON.stringify(receipt, null, 2)], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `elench-receipt-${jobId.slice(0, 8)}.json`;
		a.click();
		URL.revokeObjectURL(url);
	};
	return (
		<Section title="Evidence receipt">
			<Row k="status" v={signed ? `signed · ${receipt.key_id ?? ""}` : "unsigned"} />
			<Row k="plan sha256" v={body.plan_sha256 ? `${body.plan_sha256.slice(0, 16)}…` : "—"} />
			<Row k="catalog" v={body.catalog_version} />
			{body.tofu_version && <Row k="opentofu" v={body.tofu_version} />}
			{body.evaluated_at && <Row k="evaluated" v={body.evaluated_at} />}
			{body.exception && (
				<Row
					k="exception"
					v={`${body.exception.controls.join(", ")} by ${body.exception.by}`}
				/>
			)}
			<div className="py-2">
				<button
					type="button"
					onClick={download}
					className="w-full border border-border px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
				>
					Download receipt
				</button>
			</div>
		</Section>
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
	return (
		<div className="space-y-3">
			{plan.verifyReport && <VerifyBlock report={plan.verifyReport} />}
			{plan.receipt && <ReceiptBlock receipt={plan.receipt} jobId={jobId} />}
			{plan.planSummary ? (
				<>
					<div className="flex gap-2">
						<CountPill n={plan.planSummary.counts.create} label="add" />
						<CountPill n={plan.planSummary.counts.update} label="change" />
						<CountPill n={plan.planSummary.counts.delete} label="destroy" />
						{plan.planSummary.counts.replace > 0 && (
							<CountPill n={plan.planSummary.counts.replace} label="replace" />
						)}
					</div>
					{plan.costSummary?.totalMonthlyCost != null && (
						<div className="font-mono text-xs text-muted-foreground">
							~${plan.costSummary.totalMonthlyCost.toFixed(0)}/mo
						</div>
					)}
					<div className="divide-y divide-border border border-border">
						{plan.planSummary.resources.map((r) => (
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
				</>
			) : (
				<Empty
					text={
						plan.error
							? `Plan failed: ${plan.error}`
							: "No plan output yet — run a plan (deploy flow coming soon)."
					}
				/>
			)}
		</div>
	);
}
