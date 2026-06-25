"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The policy detail panel (ported from the Claude alerts design, primitives only): a
// view/edit surface for one policy — header + enable, a category-grouped event matrix,
// and shared routing (channels + conditions). Edits are staged locally and persisted via
// the policy server actions. See dataroom/spec/mvp/25-alerting-notifications.md.

import {
	Bell,
	Boxes,
	Check,
	CircleDollarSign,
	Copy,
	Cpu,
	Fingerprint,
	KeyRound,
	type LucideIcon,
	LogIn,
	Lock,
	Pencil,
	ShieldCheck,
	Trash2,
	Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	type ChannelDTO,
	createPolicy,
	deletePolicy,
	type PolicyDTO,
	togglePolicy,
	updatePolicy,
} from "@/app/server/actions/alerts";
import {
	type CatalogCategory,
	type CategoryIcon,
	isSecurityKey,
} from "@/lib/alerts/catalog";
import type { AlertSeverity } from "@/lib/db/schema/enums";
import type { PolicyInput } from "@/lib/validations/alerts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const CAT_ICON: Record<CategoryIcon, LucideIcon> = {
	Boxes,
	ShieldCheck,
	KeyRound,
	Users,
	Fingerprint,
	CircleDollarSign,
	Cpu,
	LogIn,
};

/** Narrows a select value to a real severity (drops the "any" sentinel). */
function isSeverity(v: string): v is AlertSeverity {
	return v === "info" || v === "warning" || v === "critical";
}

const THROTTLE_OPTIONS: { value: string; label: string }[] = [
	{ value: "0", label: "Every event" },
	{ value: "300", label: "At most every 5 min" },
	{ value: "3600", label: "At most every hour" },
	{ value: "21600", label: "At most every 6 hours" },
	{ value: "86400", label: "At most once a day" },
];

const MIN_SEV_OPTIONS: { value: string; label: string }[] = [
	{ value: "any", label: "Any severity" },
	{ value: "info", label: "Info and above" },
	{ value: "warning", label: "Warning and above" },
	{ value: "critical", label: "Critical only" },
];

interface Draft {
	name: string;
	description: string;
	events: Set<string>;
	channelIds: Set<string>;
	minSeverity: string;
	throttle: number;
	escalate: boolean;
	recipient: string;
	enabled: boolean;
}

function draftFrom(p: PolicyDTO): Draft {
	return {
		name: p.name,
		description: p.description ?? "",
		events: new Set(p.event_patterns),
		channelIds: new Set(p.channelIds),
		minSeverity: "any",
		throttle: p.throttle_seconds,
		escalate: p.escalate,
		recipient: p.recipient ?? "",
		enabled: p.enabled,
	};
}

interface PolicyDetailProps {
	policy: PolicyDTO;
	/** A freshly-seeded draft policy (not yet persisted). */
	isNew?: boolean;
	categories: CatalogCategory[];
	channels: ChannelDTO[];
	advancedAlerting: boolean;
	onSaved: () => void;
	onCancelNew: () => void;
}

/** View/edit one alert policy. */
export function PolicyDetail({
	policy,
	isNew,
	categories,
	channels,
	advancedAlerting,
	onSaved,
	onCancelNew,
}: PolicyDetailProps) {
	const [editing, setEditing] = useState(Boolean(isNew));
	const [draft, setDraft] = useState<Draft>(() => draftFrom(policy));
	const [saving, setSaving] = useState(false);

	// Reset when a different policy is selected (or a new draft seeded).
	useEffect(() => {
		setDraft(draftFrom(policy));
		setEditing(Boolean(isNew));
	}, [policy, isNew]);

	const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
	const toggleEvent = (key: string) =>
		setDraft((d) => {
			const events = new Set(d.events);
			events.has(key) ? events.delete(key) : events.add(key);
			return { ...d, events };
		});
	const toggleChannel = (id: string) =>
		setDraft((d) => {
			const channelIds = new Set(d.channelIds);
			channelIds.has(id) ? channelIds.delete(id) : channelIds.add(id);
			return { ...d, channelIds };
		});

	const securitySelected = [...draft.events].some(isSecurityKey);

	const save = async () => {
		if (draft.events.size === 0) return toast.error("Pick at least one event.");
		if (draft.channelIds.size === 0) return toast.error("Bind at least one channel.");
		if (securitySelected && !advancedAlerting) {
			return toast.error(
				"Security events require an Enterprise plan.",
			);
		}
		setSaving(true);
		try {
			const input: PolicyInput = {
				name: draft.name.trim() || "Untitled policy",
				description: draft.description || undefined,
				event_patterns: [...draft.events],
				match: isSeverity(draft.minSeverity)
					? { min_severity: draft.minSeverity }
					: {},
				severity: "warning",
				throttle_seconds: draft.throttle,
				escalate: draft.escalate,
				recipient: draft.recipient || undefined,
				enabled: draft.enabled,
				channelIds: [...draft.channelIds],
			};
			if (isNew) await createPolicy(input);
			else await updatePolicy(policy.id, input);
			toast.success(isNew ? "Policy created" : "Policy saved");
			setEditing(false);
			onSaved();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to save policy");
		} finally {
			setSaving(false);
		}
	};

	const onToggleEnabled = async (next: boolean) => {
		if (isNew) return patch({ enabled: next });
		patch({ enabled: next });
		try {
			await togglePolicy(policy.id, next);
			onSaved();
		} catch {
			patch({ enabled: !next });
			toast.error("Failed to update");
		}
	};

	const onDelete = async () => {
		if (!window.confirm(`Delete policy "${policy.name}"?`)) return;
		try {
			await deletePolicy(policy.id);
			toast.success("Policy deleted");
			onSaved();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to delete");
		}
	};

	const escalateLocked = !advancedAlerting;

	return (
		<div className="rounded-lg border border-border bg-card">
			{/* header */}
			<div className="flex items-start justify-between gap-4 border-b border-border p-5">
				<div className="flex min-w-0 gap-3">
					<span className="flex h-10 w-10 flex-none items-center justify-center rounded-md border border-border bg-muted/40">
						<Bell className="h-5 w-5" />
					</span>
					<div className="min-w-0 space-y-1.5">
						<div className="flex flex-wrap items-center gap-2.5">
							{editing ? (
								<Input
									value={draft.name}
									onChange={(e) => patch({ name: e.target.value })}
									className="h-8 w-64 font-semibold"
									placeholder="Policy name"
								/>
							) : (
								<span className="font-semibold text-lg tracking-tight">
									{policy.name}
								</span>
							)}
							{policy.is_security && <Badge variant="outline">security</Badge>}
						</div>
						{editing ? (
							<Textarea
								rows={2}
								value={draft.description}
								onChange={(e) => patch({ description: e.target.value })}
								placeholder="What this policy watches and why"
								className="text-xs"
							/>
						) : (
							policy.description && (
								<p className="max-w-prose text-muted-foreground text-xs">
									{policy.description}
								</p>
							)
						)}
					</div>
				</div>
				<div className="flex flex-none items-center gap-2">
					<span className="text-muted-foreground text-xs">
						{draft.enabled ? "Enabled" : "Off"}
					</span>
					<Switch checked={draft.enabled} onCheckedChange={onToggleEnabled} />
					{editing ? (
						<>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => (isNew ? onCancelNew() : setEditing(false))}
								disabled={saving}
							>
								Cancel
							</Button>
							<Button size="sm" onClick={save} disabled={saving}>
								{saving ? "Saving…" : isNew ? "Create" : "Save"}
							</Button>
						</>
					) : (
						<Button size="sm" variant="outline" onClick={() => setEditing(true)}>
							<Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit
						</Button>
					)}
				</div>
			</div>

			{/* meta */}
			<div className="flex flex-wrap border-b border-border">
				<Meta k="Events" v={`${draft.events.size} of ${policy ? totalEvents(categories) : 0}`} />
				<Meta
					k="Channels"
					v={
						channels
							.filter((c) => draft.channelIds.has(c.id))
							.map((c) => c.name)
							.join(", ") || "none"
					}
				/>
				<Meta
					k="Throttle"
					v={
						THROTTLE_OPTIONS.find((t) => Number(t.value) === draft.throttle)?.label ??
						`${draft.throttle}s`
					}
				/>
			</div>

			{/* event matrix */}
			<div className="border-b border-border">
				<div className="px-5 pt-4 pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
					Trigger · events
					<span className="ml-2 normal-case text-muted-foreground/80">
						{editing ? "toggle events to watch" : "edit to change the selection"}
					</span>
				</div>
				{categories.map((cat) => {
					const Icon = CAT_ICON[cat.icon] ?? Bell;
					const onCount = cat.events.filter((e) => draft.events.has(e.key)).length;
					return (
						<Collapsible key={cat.id} defaultOpen={onCount > 0}>
							<CollapsibleTrigger className="flex w-full items-center gap-2.5 px-5 py-2.5 hover:bg-muted/40">
								<Icon className="h-4 w-4 text-muted-foreground" />
								<span className="font-mono text-[10px] uppercase tracking-wider text-foreground/80">
									{cat.label}
								</span>
								<span className="ml-auto font-mono text-[10px] text-muted-foreground">
									{onCount}/{cat.events.length}
								</span>
							</CollapsibleTrigger>
							<CollapsibleContent>
								{cat.events.map((e) => {
									const on = draft.events.has(e.key);
									return (
										<div
											key={e.id}
											className="grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-2 pl-12 hover:bg-muted/30"
										>
											<div className="min-w-0">
												<div className="flex items-center gap-2 text-[13px]">
													{e.label}
													<Badge
														variant="outline"
														className="px-1.5 py-0 text-[9px] uppercase"
													>
														{e.severity}
													</Badge>
													{!e.live && (
														<span className="font-mono text-[9px] text-muted-foreground/70">
															soon
														</span>
													)}
												</div>
												<div className="font-mono text-[10px] text-muted-foreground/70">
													{e.key}
												</div>
											</div>
											{editing ? (
												<Switch
													checked={on}
													onCheckedChange={() => toggleEvent(e.key)}
												/>
											) : (
												<span
													className={cn(
														"flex items-center gap-1.5 font-mono text-[10px] uppercase",
														on ? "text-foreground" : "text-muted-foreground/60",
													)}
												>
													<span
														className={cn(
															"h-1.5 w-1.5 rounded-full",
															on ? "bg-foreground" : "border border-border",
														)}
													/>
													{on ? "On" : "Off"}
												</span>
											)}
										</div>
									);
								})}
							</CollapsibleContent>
						</Collapsible>
					);
				})}
			</div>

			{/* routing */}
			<div className="space-y-4 p-5">
				<div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
					Routing
				</div>
				<div className="flex flex-wrap gap-2">
					{channels.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							No channels yet — add one in the Channels tab.
						</p>
					) : (
						channels.map((c) => {
							const on = draft.channelIds.has(c.id);
							return (
								<button
									key={c.id}
									type="button"
									disabled={!editing}
									onClick={() => toggleChannel(c.id)}
									className={cn(
										"flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
										on
											? "border-foreground/40 bg-muted"
											: "border-border bg-card hover:bg-muted/40",
										!editing && "cursor-default",
									)}
								>
									<span
										className={cn(
											"flex h-4 w-4 items-center justify-center rounded border",
											on
												? "border-foreground bg-foreground text-background"
												: "border-border",
										)}
									>
										{on && <Check className="h-3 w-3" />}
									</span>
									{c.name}
									<span className="text-muted-foreground text-xs">{c.type}</span>
								</button>
							);
						})
					)}
				</div>

				<Condition title="Minimum severity" hint="Only fire at or above this level.">
					<Select
						value={draft.minSeverity}
						onValueChange={(v) => patch({ minSeverity: v })}
						disabled={!editing}
					>
						<SelectTrigger className="w-52">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{MIN_SEV_OPTIONS.map((o) => (
								<SelectItem key={o.value} value={o.value}>
									{o.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Condition>

				<Condition
					title="Dedup window"
					hint="Collapse repeats of the same event within this window."
				>
					<Select
						value={String(draft.throttle)}
						onValueChange={(v) => patch({ throttle: Number(v) })}
						disabled={!editing}
					>
						<SelectTrigger className="w-52">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{THROTTLE_OPTIONS.map((o) => (
								<SelectItem key={o.value} value={o.value}>
									{o.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Condition>

				<Condition
					title="Escalate if unacknowledged"
					hint="Page again after a delay if no one acknowledges."
					locked={escalateLocked}
				>
					<Switch
						checked={draft.escalate && !escalateLocked}
						disabled={!editing || escalateLocked}
						onCheckedChange={(v) => patch({ escalate: v })}
					/>
				</Condition>

				<Condition
					title="Recipient"
					hint="On-call schedule or team to notify."
					locked={escalateLocked}
				>
					<Input
						value={draft.recipient}
						disabled={!editing || escalateLocked}
						onChange={(e) => patch({ recipient: e.target.value })}
						placeholder="Platform on-call"
						className="w-52"
					/>
				</Condition>
			</div>

			{/* footer */}
			{!isNew && !editing && (
				<div className="flex items-center justify-between border-t border-border bg-muted/30 px-5 py-3">
					<span className="text-muted-foreground text-xs">
						{policy.is_security
							? "Security policy · PDP-sourced events"
							: "Operational policy"}
					</span>
					<Button variant="ghost" size="sm" onClick={onDelete}>
						<Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
					</Button>
				</div>
			)}
		</div>
	);
}

function totalEvents(categories: CatalogCategory[]): number {
	return categories.reduce((n, c) => n + c.events.length, 0);
}

function Meta({ k, v }: { k: string; v: string }) {
	return (
		<div className="min-w-[130px] flex-1 border-r border-border px-5 py-3 last:border-r-0">
			<div className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
				{k}
			</div>
			<div className="mt-1.5 truncate text-[13px]">{v}</div>
		</div>
	);
}

function Condition({
	title,
	hint,
	locked,
	children,
}: {
	title: string;
	hint: string;
	locked?: boolean;
	children: React.ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-4 border-t border-border py-3 first:border-t-0">
			<div>
				<div className="flex items-center gap-2 text-[13px]">
					{title}
					{locked && <Lock className="h-3 w-3 text-muted-foreground" />}
				</div>
				<div className="max-w-prose text-muted-foreground text-xs">
					{locked ? `${hint} (Enterprise plan)` : hint}
				</div>
			</div>
			{children}
		</div>
	);
}
