"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Alerts surface (ported from the Claude alerts design, primitives only): a
// policy-centric master-detail — stats, a template gallery, a policy rail + the policy
// detail editor — plus secondary Channels and Activity tabs. See dataroom/spec/mvp/25.

import { Plus, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
	type AlertsBootstrap,
	type ChannelDTO,
	deleteChannel,
	type PolicyDTO,
	verifyChannel,
} from "@/app/server/actions/alerts";
import { ChannelDialog } from "@/components/alerts/channel-dialog";
import { PolicyDetail } from "@/components/alerts/policy-detail";
import { isSecurityKey } from "@/lib/alerts/catalog";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import {
	Collapsible,
	CollapsibleContent,
} from "@repo/ui/collapsible";
import { Input } from "@repo/ui/input";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import type { AlertDeliveryStatus } from "@/lib/db/schema/enums";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/tabs";
import { cn } from "@repo/ui/utils";

const DELIVERY_TIER: Record<AlertDeliveryStatus, StatusTier> = {
	sent: "active",
	pending: "pending",
	failed: "failed",
	dead: "disabled",
};

interface Template {
	name: string;
	description: string;
	event_patterns: string[];
}

const TEMPLATES: Template[] = [
	{ name: "Blank policy", description: "Start from scratch and pick events yourself.", event_patterns: [] },
	{
		name: "Production deploy failures",
		description: "Failed deploys and destroys, paged to on-call.",
		event_patterns: ["system.job.failed", "system.spec.destroyed"],
	},
	{
		name: "Security & policy denials",
		description: "Every PDP denial and sensitive action — the compliance default.",
		event_patterns: ["authz.*.*.denied", "authz.*.destroy.allowed"],
	},
	{
		name: "Access changes audit",
		description: "Grants, revocations and role edits — an access paper trail.",
		event_patterns: ["authz.grant.assign", "authz.grant.revoke", "authz.role.edit"],
	},
	{
		name: "Cost guardrails",
		description: "Budget thresholds, spend spikes and overage starts.",
		event_patterns: ["system.cost.budget_threshold", "system.cost.spend_spike", "system.cost.overage"],
	},
	{
		name: "Worker & runner health",
		description: "Unhealthy or stalled workers and exhausted runner minutes.",
		event_patterns: ["system.runner.offline", "system.runner.stalled", "system.runner.exhausted"],
	},
];

/** A not-yet-persisted draft policy seeded from a template. */
function blankPolicy(seed?: Partial<PolicyDTO>): PolicyDTO {
	const patterns = seed?.event_patterns ?? [];
	return {
		id: "",
		name: seed?.name ?? "New policy",
		description: seed?.description ?? null,
		event_patterns: patterns,
		is_security: patterns.some(isSecurityKey),
		severity: "warning",
		throttle_seconds: 300,
		escalate: false,
		recipient: null,
		enabled: false,
		channelIds: [],
	};
}

export function AlertsPage({ bootstrap }: { bootstrap: AlertsBootstrap }) {
	const router = useRouter();
	const {
		channels,
		policies,
		deliveries,
		categories,
		stats,
		advancedAlerting,
		encryptionConfigured,
	} = bootstrap;

	const [query, setQuery] = useState("");
	const [galleryOpen, setGalleryOpen] = useState(policies.length === 0);
	const [selectedId, setSelectedId] = useState<string | null>(
		policies[0]?.id ?? null,
	);
	const [draft, setDraft] = useState<PolicyDTO | null>(null);
	const [channelDialog, setChannelDialog] = useState<{
		open: boolean;
		channel?: ChannelDTO;
	}>({ open: false });
	const [testing, setTesting] = useState<string | null>(null);

	const refresh = () => router.refresh();

	const startTemplate = (t: Template) => {
		setDraft(
			blankPolicy({
				name: t.name === "Blank policy" ? "New policy" : t.name,
				description: t.description,
				event_patterns: t.event_patterns,
			}),
		);
		setSelectedId(null);
		setGalleryOpen(false);
	};

	const onSaved = () => {
		setDraft(null);
		refresh();
	};

	const filtered = policies.filter(
		(p) => !query.trim() || p.name.toLowerCase().includes(query.toLowerCase()),
	);
	const shown =
		draft ?? policies.find((p) => p.id === selectedId) ?? policies[0] ?? null;

	const onTest = async (id: string) => {
		setTesting(id);
		try {
			const res = await verifyChannel(id);
			if (res.ok) toast.success("Test delivery sent");
			else toast.error(res.error ?? "Test failed");
		} finally {
			setTesting(null);
			refresh();
		}
	};
	const onDeleteChannel = async (c: ChannelDTO) => {
		if (!window.confirm(`Delete channel "${c.name}"?`)) return;
		try {
			await deleteChannel(c.id);
			toast.success("Channel deleted");
			refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to delete");
		}
	};

	return (
		<div className="space-y-6 p-6">
			<div>
				<p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
					Alerts
				</p>
				<h1 className="mt-1.5 font-semibold text-2xl tracking-tight">
					Alert policies
				</h1>
				<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
					A policy watches a set of events and routes them to channels. Every
					deploy, policy decision, access change and identity event can fire one —
					start from a template, then tune the events, conditions and routing.
				</p>
			</div>

			<Tabs defaultValue="policies">
				<TabsList>
					<TabsTrigger value="policies">Policies</TabsTrigger>
					<TabsTrigger value="channels">Channels</TabsTrigger>
					<TabsTrigger value="activity">Activity</TabsTrigger>
				</TabsList>

				{/* ── Policies ──────────────────────────────────────────── */}
				<TabsContent value="policies" className="space-y-4">
					{/* stats */}
					<div className="grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-lg border border-border sm:grid-cols-4 sm:divide-y-0">
						<Stat k="Policies" v={stats.policies} sub="configured" />
						<Stat k="Enabled" v={stats.enabled} sub="active" />
						<Stat
							k="Events covered"
							v={stats.eventsCovered}
							sub={`/ ${stats.totalEvents}`}
						/>
						<Stat k="Routed 24h" v={stats.routed24h} sub="notifications" />
					</div>

					{/* toolbar */}
					<div className="flex items-center justify-between gap-4">
						<div className="relative w-64">
							<Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
							<Input
								placeholder="Search policies"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								className="h-9 bg-muted/30 pl-9 text-sm"
							/>
						</div>
						<Button size="sm" onClick={() => setGalleryOpen((o) => !o)}>
							<Plus className="mr-1 h-4 w-4" /> New policy
						</Button>
					</div>

					{/* template gallery */}
					<Collapsible open={galleryOpen}>
						<CollapsibleContent>
							<div className="rounded-lg border border-border">
								<div className="border-b border-border bg-muted/30 px-4 py-3">
									<p className="font-medium text-sm">Start from a template</p>
									<p className="text-muted-foreground text-xs">
										Curated event sets for common needs. Everything stays editable.
									</p>
								</div>
								<div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-3">
									{TEMPLATES.map((t) => (
										<button
											key={t.name}
											type="button"
											onClick={() => startTemplate(t)}
											className="flex flex-col gap-1.5 bg-card p-4 text-left hover:bg-muted/40"
										>
											<span className="font-medium text-sm">{t.name}</span>
											<span className="text-muted-foreground text-xs">
												{t.description}
											</span>
											<span className="mt-1 font-mono text-[10px] text-muted-foreground/70">
												{t.event_patterns.length === 0
													? "no events"
													: `${t.event_patterns.length} events`}
											</span>
										</button>
									))}
								</div>
							</div>
						</CollapsibleContent>
					</Collapsible>

					{/* master-detail */}
					<div className="flex flex-wrap items-start gap-4">
						<div className="min-w-[260px] flex-1 overflow-hidden rounded-lg border border-border">
							<div className="px-4 py-2.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
								Policies
							</div>
							{filtered.length === 0 ? (
								<div className="px-4 py-4 text-muted-foreground text-xs">
									{policies.length === 0
										? "No policies yet — start from a template."
										: "No policies match."}
								</div>
							) : (
								filtered.map((p) => (
									<button
										key={p.id}
										type="button"
										onClick={() => {
											setDraft(null);
											setSelectedId(p.id);
										}}
										className={cn(
											"flex w-full items-center gap-3 border-b border-border border-l-2 px-3.5 py-3 text-left hover:bg-muted/40",
											!draft && shown?.id === p.id
												? "border-l-foreground bg-muted/40"
												: "border-l-transparent",
										)}
									>
										<span
											className={cn(
												"h-2 w-2 flex-none rounded-full",
												p.enabled ? "bg-foreground" : "border border-border",
											)}
										/>
										<span className="min-w-0 flex-1">
											<span className="block truncate font-medium text-[13px]">
												{p.name}
											</span>
											<span className="font-mono text-[10px] text-muted-foreground">
												{p.event_patterns.length} events ·{" "}
												{p.enabled ? "enabled" : "off"}
											</span>
										</span>
										<span className="font-mono text-[10px] text-muted-foreground">
											{p.channelIds.length}ch
										</span>
									</button>
								))
							)}
						</div>

						<div className="min-w-[min(480px,100%)] flex-[100]">
							{shown ? (
								<PolicyDetail
									key={draft ? "draft" : shown.id}
									policy={shown}
									isNew={Boolean(draft)}
									categories={categories}
									channels={channels}
									advancedAlerting={advancedAlerting}
									onSaved={onSaved}
									onCancelNew={() => setDraft(null)}
								/>
							) : (
								<div className="rounded-lg border border-border p-10 text-center text-muted-foreground text-sm">
									Select a policy, or create one from a template.
								</div>
							)}
						</div>
					</div>
				</TabsContent>

				{/* ── Channels ──────────────────────────────────────────── */}
				<TabsContent value="channels" className="space-y-4">
					{!encryptionConfigured && (
						<div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-xs">
							Webhook, Slack and RocketChat channels store a URL secret, which needs an
							encryption key. Set{" "}
							<code className="font-mono text-foreground">ALETHIA_CRED_ENCRYPTION_KEY</code>{" "}
							(generate: <code className="font-mono">openssl rand -base64 32</code>) and
							restart to enable them. Email channels work without it.
						</div>
					)}
					<div className="flex justify-end">
						<Button size="sm" onClick={() => setChannelDialog({ open: true })}>
							<Plus className="mr-1 h-4 w-4" /> New channel
						</Button>
					</div>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Name</TableHead>
								<TableHead>Type</TableHead>
								<TableHead>Status</TableHead>
								<TableHead className="text-right">Actions</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{channels.length === 0 ? (
								<TableRow>
									<TableCell colSpan={4} className="text-muted-foreground">
										No channels yet.
									</TableCell>
								</TableRow>
							) : (
								channels.map((c) => (
									<TableRow key={c.id}>
										<TableCell className="font-medium">{c.name}</TableCell>
										<TableCell>{c.type}</TableCell>
										<TableCell>
											<StatusBadge
												status={c.is_verified ? "active" : "idle"}
												label={c.is_verified ? "Verified" : "Unverified"}
											/>
										</TableCell>
										<TableCell className="space-x-2 text-right">
											<Button
												variant="ghost"
												size="sm"
												onClick={() => onTest(c.id)}
												disabled={testing === c.id}
											>
												{testing === c.id ? "Testing…" : "Test"}
											</Button>
											<Button
												variant="ghost"
												size="sm"
												onClick={() => setChannelDialog({ open: true, channel: c })}
											>
												Edit
											</Button>
											<Button
												variant="ghost"
												size="sm"
												onClick={() => onDeleteChannel(c)}
											>
												Delete
											</Button>
										</TableCell>
									</TableRow>
								))
							)}
						</TableBody>
					</Table>
				</TabsContent>

				{/* ── Activity ──────────────────────────────────────────── */}
				<TabsContent value="activity" className="space-y-4">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Event</TableHead>
								<TableHead>Status</TableHead>
								<TableHead>Attempts</TableHead>
								<TableHead>When</TableHead>
								<TableHead>Error</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{deliveries.length === 0 ? (
								<TableRow>
									<TableCell colSpan={5} className="text-muted-foreground">
										No deliveries yet.
									</TableCell>
								</TableRow>
							) : (
								deliveries.map((d) => (
									<TableRow key={d.id}>
										<TableCell className="font-medium">{d.title}</TableCell>
										<TableCell>
											<StatusBadge
												status={d.status}
												tier={DELIVERY_TIER[d.status]}
												label={d.status}
											/>
										</TableCell>
										<TableCell>{d.attempts}</TableCell>
										<TableCell className="text-muted-foreground">
											{new Date(d.created_at).toLocaleString()}
										</TableCell>
										<TableCell className="max-w-xs truncate text-muted-foreground text-xs">
											{d.last_error ?? "—"}
										</TableCell>
									</TableRow>
								))
							)}
						</TableBody>
					</Table>
				</TabsContent>
			</Tabs>

			{channelDialog.open && (
				<ChannelDialog
					open={channelDialog.open}
					onOpenChange={(open) => setChannelDialog({ open })}
					channel={channelDialog.channel}
					encryptionConfigured={encryptionConfigured}
					onSaved={refresh}
				/>
			)}
		</div>
	);
}

function Stat({ k, v, sub }: { k: string; v: number; sub: string }) {
	return (
		<div className="bg-card px-4 py-3.5">
			<div className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground">
				{k}
			</div>
			<div className="mt-1.5 flex items-baseline gap-1.5">
				<span className="font-semibold text-xl tracking-tight">{v}</span>
				<span className="font-mono text-[11px] text-muted-foreground">{sub}</span>
			</div>
		</div>
	);
}
