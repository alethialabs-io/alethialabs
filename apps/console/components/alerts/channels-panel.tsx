"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alerts hub · Channels panel. A master-detail: a rail of channels + an inline detail.
// Adding a channel opens the guided ChannelSheet (which verifies before creating); existing
// channels edit in place (no edit button) with a dirty Save/Discard bar, a standalone
// enable switch that confirms on disable, the unified ChannelVerify re-verify control, and
// a confirmed Delete. "Used by" cross-links into the Policies section.

import { Plus, Search, Send, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	type AlertsBootstrap,
	type ChannelDTO,
	deleteChannel,
	setChannelEnabled,
	updateChannel,
} from "@/app/server/actions/alerts";
import { ChannelIcon } from "@/components/alerts/channel-icon";
import { ClassificationChips } from "@/components/classification/classification-chips";
import { ClassificationControl } from "@/components/classification/classification-control";
import type { AssignedValue } from "@/lib/queries/classification";
import { useAssignmentsForKind } from "@/lib/query/use-classification-query";
import { ChannelSheet } from "@/components/alerts/channel-sheet";
import { ChannelVerify } from "@/components/alerts/channel-verify";
import { CHANNEL_TYPE_META } from "@/components/alerts/channel-meta";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
import { FieldHelp } from "@/components/alerts/field-help";
import { RecipientsEditor } from "@/components/alerts/recipients-editor";
import { useAlertsSection } from "@/lib/stores/use-alerts-section";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { Switch } from "@repo/ui/switch";
import { cn } from "@repo/ui/utils";

function statusLabel(c: ChannelDTO): string {
	if (!c.enabled) return "Paused";
	return c.is_verified ? "Verified" : "Not verified";
}
function targetOf(c: ChannelDTO): string {
	if (c.type === "email")
		return c.recipients.length
			? c.recipients[0] +
					(c.recipients.length > 1 ? ` +${c.recipients.length - 1}` : "")
			: "No recipients";
	return c.has_secret ? "Endpoint configured" : "Not configured";
}
function sameRecipients(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

interface ChannelsPanelProps {
	bootstrap: AlertsBootstrap;
	onChanged: () => void;
	onOpenPolicy: (id?: string) => void;
}

/** Channels master-detail. */
export function ChannelsPanel({
	bootstrap,
	onChanged,
	onOpenPolicy,
}: ChannelsPanelProps) {
	const { channels, policies, canManage, encryptionConfigured } = bootstrap;
	const selectedId = useAlertsSection((s) => s.selectedChannelId);
	const setSelectedId = useAlertsSection((s) => s.setSelectedChannelId);

	const [query, setQuery] = useState("");
	const [sheetOpen, setSheetOpen] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState<ChannelDTO | null>(null);

	const selected =
		channels.find((c) => c.id === selectedId) ?? channels[0] ?? null;
	// One batched query hydrates every channel row's classification chips.
	const { data: classMap = {} } = useAssignmentsForKind(
		"alert_channel",
		channels.map((c) => c.id),
	);
	const filtered = channels.filter(
		(c) =>
			!query.trim() ||
			c.name.toLowerCase().includes(query.toLowerCase()) ||
			c.type.includes(query.toLowerCase()),
	);

	const doDelete = async (c: ChannelDTO) => {
		try {
			await deleteChannel(c.id);
			toast.success("Channel deleted");
			setSelectedId(null);
			onChanged();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to delete");
		}
	};

	const addBtn = canManage && (
		<Button size="sm" onClick={() => setSheetOpen(true)}>
			<Plus className="mr-1 size-3.5" /> Add channel
		</Button>
	);

	const policiesUsing = (id: string) =>
		policies.filter((p) => p.channelIds.includes(id));

	return (
		<div>
			{channels.length === 0 ? (
				<EmptyState canManage={canManage} action={addBtn} />
			) : (
				<>
					{/* toolbar */}
					<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
						<div className="flex items-center gap-3">
							<div className="relative w-[230px]">
								<Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
								<Input
									value={query}
									onChange={(e) => setQuery(e.target.value)}
									placeholder="Search channels"
									className="h-9 border-border/60 bg-muted/20 pl-9 text-sm"
								/>
							</div>
							<span className="font-mono text-[10px] text-muted-foreground">
								{channels.length} channels
							</span>
						</div>
						{addBtn}
					</div>

					{/* master-detail */}
					<div className="flex flex-wrap items-start gap-4">
						<div className="min-w-[290px] flex-1 overflow-hidden rounded-xl border border-border/60 bg-background shadow-sm">
							<div className="px-4 py-3 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/70">
								Configured channels
							</div>
							{filtered.length === 0 ? (
								<div className="px-4 py-4 text-muted-foreground/70 text-xs">
									No channels match.
								</div>
							) : (
								filtered.map((c) => (
									<ChannelRow
										key={c.id}
										channel={c}
										selected={selected?.id === c.id}
										onSelect={() => setSelectedId(c.id)}
										assignments={classMap[c.id]}
									/>
								))
							)}
						</div>

						<div className="min-w-[min(500px,100%)] flex-[100]">
							{selected ? (
								<ChannelDetail
									key={selected.id}
									channel={selected}
									canManage={canManage}
									encryptionConfigured={encryptionConfigured}
									usingPolicies={policiesUsing(selected.id)}
									onChanged={onChanged}
									onRequestDelete={() => setDeleteTarget(selected)}
									onOpenPolicy={onOpenPolicy}
								/>
							) : (
								<div className="rounded-xl border border-border/60 bg-background p-12 text-center text-muted-foreground text-sm shadow-sm">
									Select a channel to view it.
								</div>
							)}
						</div>
					</div>
				</>
			)}

			{canManage && (
				<ChannelSheet
					open={sheetOpen}
					onOpenChange={setSheetOpen}
					bootstrap={bootstrap}
					onSaved={onChanged}
				/>
			)}

			<ConfirmDialog
				open={deleteTarget !== null}
				onOpenChange={(o) => !o && setDeleteTarget(null)}
				title={`Delete channel "${deleteTarget?.name ?? ""}"?`}
				description={
					deleteTarget && policiesUsing(deleteTarget.id).length > 0
						? `${policiesUsing(deleteTarget.id).length} policy/policies route here and will lose this destination. Delivery history is kept. This cannot be undone.`
						: "Delivery history is kept. This cannot be undone."
				}
				confirmLabel="Delete channel"
				onConfirm={() => {
					if (deleteTarget) doDelete(deleteTarget);
					setDeleteTarget(null);
				}}
			/>
		</div>
	);
}

function ChannelRow({
	channel,
	selected,
	onSelect,
	assignments,
}: {
	channel: ChannelDTO;
	selected: boolean;
	onSelect: () => void;
	assignments?: AssignedValue[];
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"flex w-full items-center gap-3 border-b border-l-2 border-border/60 px-3.5 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/40",
				selected ? "border-l-foreground bg-muted/40" : "border-l-transparent",
			)}
		>
			<ChannelTile type={channel.type} active={channel.is_verified} />
			<span className="min-w-0 flex-1">
				<span className="block truncate font-medium text-[13px]">
					{channel.name}
				</span>
				<span className="truncate font-mono text-[10px] text-muted-foreground">
					{targetOf(channel)}
				</span>
				<ClassificationChips
					kind="alert_channel"
					id={channel.id}
					initialAssignments={assignments}
					className="mt-1 flex"
				/>
			</span>
			<StatusDot
				tone={!channel.enabled ? "idle" : channel.is_verified ? "ok" : "idle"}
			/>
		</button>
	);
}

function EmptyState({
	canManage,
	action,
}: {
	canManage: boolean;
	action: React.ReactNode;
}) {
	return (
		<div className="flex flex-col items-center justify-center py-16 text-center">
			<div className="mb-4 flex size-11 items-center justify-center rounded-full bg-muted/50 text-muted-foreground">
				<Send className="size-5" />
			</div>
			<h3 className="mb-1 font-medium text-sm text-foreground">
				No channels yet
			</h3>
			<p className="max-w-sm text-muted-foreground text-xs">
				Channels are where alerts get delivered — Slack, email, Rocket.Chat or a
				signed webhook.{canManage ? " Add one to start." : ""}
			</p>
			{canManage && <div className="mt-4">{action}</div>}
		</div>
	);
}

interface ChDetailProps {
	channel: ChannelDTO;
	canManage: boolean;
	encryptionConfigured: boolean;
	usingPolicies: AlertsBootstrap["policies"];
	onChanged: () => void;
	onRequestDelete: () => void;
	onOpenPolicy: (id?: string) => void;
}

function ChannelDetail({
	channel,
	canManage,
	encryptionConfigured,
	usingPolicies,
	onChanged,
	onRequestDelete,
	onOpenPolicy,
}: ChDetailProps) {
	const meta = CHANNEL_TYPE_META[channel.type];

	// Directly-editable draft (no edit-mode toggle). Reset whenever the channel changes.
	const [name, setName] = useState(channel.name);
	const [recipients, setRecipients] = useState<string[]>(channel.recipients);
	const [url, setUrl] = useState("");
	const [secret, setSecret] = useState("");
	const [routingKey, setRoutingKey] = useState("");
	const [saving, setSaving] = useState(false);
	const [disableConfirm, setDisableConfirm] = useState(false);
	const [togglePending, setTogglePending] = useState(false);

	useEffect(() => {
		setName(channel.name);
		setRecipients(channel.recipients);
		setUrl("");
		setSecret("");
		setRoutingKey("");
	}, [channel]);

	const dirty =
		name.trim() !== channel.name ||
		!sameRecipients(recipients, channel.recipients) ||
		url.trim() !== "" ||
		secret.trim() !== "" ||
		routingKey.trim() !== "";
	const needsKey = meta.credential !== "email" && !encryptionConfigured;

	const discard = () => {
		setName(channel.name);
		setRecipients(channel.recipients);
		setUrl("");
		setSecret("");
		setRoutingKey("");
	};

	const save = async () => {
		if (channel.type === "email" && recipients.length === 0)
			return toast.error("Add at least one recipient.");
		setSaving(true);
		try {
			await updateChannel(channel.id, {
				type: channel.type,
				name: name.trim() || meta.name,
				enabled: channel.enabled,
				recipients: channel.type === "email" ? recipients : undefined,
				secret:
					meta.credential === "url"
						? {
								url: url.trim() || undefined,
								signingSecret:
									channel.type === "webhook" ? secret.trim() || undefined : undefined,
							}
						: meta.credential === "routingKey"
							? { routingKey: routingKey.trim() || undefined }
							: undefined,
			});
			setUrl("");
			setSecret("");
			setRoutingKey("");
			toast.success("Channel saved");
			onChanged();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to save channel");
		} finally {
			setSaving(false);
		}
	};

	const applyEnabled = async (next: boolean) => {
		setTogglePending(true);
		try {
			await setChannelEnabled(channel.id, next);
			onChanged();
		} catch {
			toast.error("Failed to update");
		} finally {
			setTogglePending(false);
		}
	};
	const onToggle = (next: boolean) => {
		if (!next) setDisableConfirm(true); // confirm only when disabling
		else applyEnabled(true);
	};

	return (
		<div className="overflow-hidden rounded-xl border border-border/60 bg-background shadow-sm">
			{/* header */}
			<div className="flex items-start justify-between gap-4 border-b border-border/60 p-5">
				<div className="flex min-w-0 gap-3">
					<ChannelTile type={channel.type} active={channel.is_verified} size="lg" />
					<div className="min-w-0 space-y-1.5">
						{canManage ? (
							<Input
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="Channel name"
								className="h-8 w-64 font-display font-semibold text-lg"
							/>
						) : (
							<span className="font-display font-semibold text-lg tracking-tight">
								{channel.name}
							</span>
						)}
						<p className="max-w-prose text-muted-foreground text-xs leading-relaxed">
							{meta.desc}
						</p>
						{/* Classification (Workstream B) — chips + a picker for managers. */}
						<ClassificationControl
							kind="alert_channel"
							id={channel.id}
							canEdit={canManage}
							className="pt-1"
						/>
					</div>
				</div>
				<span className="flex flex-none items-center gap-1.5 font-mono text-[10px] uppercase text-muted-foreground">
					<StatusDot
						tone={!channel.enabled ? "idle" : channel.is_verified ? "ok" : "idle"}
					/>
					{statusLabel(channel)}
				</span>
			</div>

			{/* meta */}
			<div className="flex flex-wrap border-b border-border/60">
				<MetaCell k="Transport" v={meta.transport} />
				<MetaCell k="Target" v={targetOf(channel)} mono />
				<MetaCell
					k="Used by"
					v={`${usingPolicies.length} ${usingPolicies.length === 1 ? "policy" : "policies"}`}
				/>
			</div>

			{/* config */}
			<div className="space-y-4 border-b border-border/60 p-5">
				<div className="flex items-center gap-1.5">
					<span className="font-mono text-[10px] uppercase tracking-wider text-foreground/70">
						{meta.credential === "email"
							? "Recipients"
							: meta.credential === "routingKey"
								? "Connection"
								: "Endpoint"}
					</span>
					<FieldHelp title="Configuration">{endpointHelp(channel.type)}</FieldHelp>
				</div>

				{needsKey && (
					<div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-muted-foreground text-xs">
						This transport stores a secret, which needs an encryption key. Set{" "}
						<code className="font-mono text-foreground">
							ALETHIA_CRED_ENCRYPTION_KEY
						</code>{" "}
						and restart, or use an Email channel.
					</div>
				)}

				{meta.credential === "email" && (
					<RecipientsEditor
						recipients={recipients}
						editable={canManage}
						onChange={setRecipients}
					/>
				)}

				{meta.credential === "routingKey" && (
					<div className="space-y-2">
						<Label>Integration routing key</Label>
						{canManage ? (
							<Input
								value={routingKey}
								onChange={(e) => setRoutingKey(e.target.value)}
								placeholder="•••••• (leave blank to keep current)"
								className="font-mono text-xs"
							/>
						) : (
							<p className="font-mono text-muted-foreground text-xs">
								{channel.has_secret ? "•••••• (stored, encrypted)" : "Not configured"}
							</p>
						)}
					</div>
				)}

				{meta.credential === "url" && (
					<div className="space-y-4">
						<div className="space-y-2">
							<Label>
								{channel.type === "webhook"
									? "Payload URL"
									: `${meta.name} webhook URL`}
							</Label>
							{canManage ? (
								<Input
									value={url}
									onChange={(e) => setUrl(e.target.value)}
									placeholder="•••••• (leave blank to keep current)"
									className="font-mono text-xs"
								/>
							) : (
								<p className="font-mono text-muted-foreground text-xs">
									{channel.has_secret
										? "•••••• (stored, encrypted)"
										: "Not configured"}
								</p>
							)}
						</div>
						{channel.type === "webhook" && canManage && (
							<div className="space-y-2">
								<div className="flex items-center gap-1.5">
									<Label>Signing secret</Label>
									<FieldHelp title="Signing secret">
										Optional. If set, Alethia signs each request body and sends{" "}
										<code className="font-mono">X-Alethia-Signature: sha256=…</code>{" "}
										so your receiver can verify the request came from Alethia.
									</FieldHelp>
								</div>
								<Input
									value={secret}
									onChange={(e) => setSecret(e.target.value)}
									placeholder="Leave blank to keep current"
									className="font-mono text-xs"
								/>
							</div>
						)}
					</div>
				)}
			</div>

			{/* enable — standalone, confirm on disable */}
			{canManage && (
				<div className="flex items-center justify-between gap-4 border-b border-border/60 p-5">
					<div>
						<div className="text-sm">
							{channel.enabled ? "Enabled" : "Disabled"}
						</div>
						<div className="text-muted-foreground text-xs">
							{channel.enabled
								? "Receiving alerts from the policies routed here."
								: "Paused — policies routed here won't deliver."}
						</div>
					</div>
					<Switch
						checked={channel.enabled}
						disabled={togglePending}
						onCheckedChange={onToggle}
					/>
				</div>
			)}

			{/* verification */}
			<div className="border-b border-border/60 p-5">
				<ChannelVerify
					channelId={channel.id}
					isVerified={channel.is_verified}
					lastVerifiedAt={channel.last_verified_at}
					canManage={canManage}
					onVerified={onChanged}
				/>
			</div>

			{/* used by */}
			<div className="space-y-3 border-b border-border/60 p-5">
				<div className="flex items-center gap-2">
					<span className="font-mono text-[10px] uppercase tracking-wider text-foreground/70">
						Used by
					</span>
					<button
						type="button"
						onClick={() => onOpenPolicy()}
						className="ml-auto text-muted-foreground text-xs hover:text-foreground"
					>
						All policies →
					</button>
				</div>
				{usingPolicies.length === 0 ? (
					<p className="text-muted-foreground text-xs">
						Not referenced by any policy yet.
					</p>
				) : (
					<div className="flex flex-wrap gap-2">
						{usingPolicies.map((p) => (
							<button
								key={p.id}
								type="button"
								onClick={() => onOpenPolicy(p.id)}
								className="flex items-center gap-2 rounded-full border border-border/60 px-3 py-1 text-muted-foreground text-xs transition-colors hover:border-foreground/30 hover:text-foreground"
							>
								<StatusDot tone={p.enabled ? "ok" : "idle"} />
								{p.name} →
							</button>
						))}
					</div>
				)}
			</div>

			{/* footer: delete */}
			{canManage && (
				<div className="flex items-center justify-end bg-muted/20 px-5 py-3">
					<Button
						variant="ghost"
						size="sm"
						onClick={onRequestDelete}
						className="text-destructive hover:text-destructive"
					>
						<Trash2 className="mr-1.5 size-3.5" /> Delete channel
					</Button>
				</div>
			)}

			{/* dirty save bar */}
			{canManage && dirty && (
				<div className="sticky bottom-0 flex items-center justify-between gap-4 border-t border-border bg-background/95 px-5 py-3 backdrop-blur">
					<span className="text-muted-foreground text-xs">Unsaved changes</span>
					<div className="flex items-center gap-2">
						<Button variant="ghost" size="sm" onClick={discard} disabled={saving}>
							Discard
						</Button>
						<Button size="sm" onClick={save} disabled={saving}>
							{saving ? "Saving…" : "Save changes"}
						</Button>
					</div>
				</div>
			)}

			<ConfirmDialog
				open={disableConfirm}
				onOpenChange={setDisableConfirm}
				title="Disable this channel?"
				description="Policies routing here stop delivering until you re-enable it. You can re-enable any time."
				confirmLabel="Disable"
				onConfirm={() => applyEnabled(false)}
			/>
		</div>
	);
}

/** Help copy for the endpoint/recipients field, per transport. */
function endpointHelp(type: ChannelDTO["type"]) {
	switch (type) {
		case "email":
			return "People or distribution lists that receive this channel. Type an address and press Enter or comma; paste a list to add several at once.";
		case "slack":
			return "In Slack: Apps → Incoming Webhooks → Add to a channel, then paste the webhook URL here.";
		case "rocketchat":
			return "In Rocket.Chat: Admin → Integrations → New → Incoming Webhook, enable it, then paste the generated URL.";
		case "discord":
			return "In Discord: Channel → Edit → Integrations → Webhooks → New Webhook, then copy the webhook URL.";
		case "teams":
			return "In Microsoft Teams: add a Workflows / Incoming Webhook connector to the channel and paste its POST URL.";
		case "mattermost":
			return "In Mattermost: Integrations → Incoming Webhooks → Add, then paste the URL.";
		case "googlechat":
			return "In a Google Chat space: Apps & integrations → Webhooks, add one and copy its URL.";
		case "pagerduty":
			return "In PagerDuty: a service's Integrations → Events API v2 integration — paste its Integration Key.";
		default:
			return "Any HTTPS endpoint. Alethia POSTs a JSON event body to it.";
	}
}

function ChannelTile({
	type,
	active,
	size = "sm",
}: {
	type: ChannelDTO["type"];
	active: boolean;
	size?: "sm" | "lg";
}) {
	return (
		<span
			className={cn(
				"flex flex-none items-center justify-center rounded-md border border-border/60 bg-muted/30",
				size === "lg" ? "size-10" : "size-8",
			)}
		>
			<ChannelIcon type={type} active={active} size={size === "lg" ? 22 : 16} />
		</span>
	);
}

function StatusDot({ tone }: { tone: "ok" | "idle" }) {
	return (
		<span
			className={cn(
				"size-2 flex-none rounded-full",
				tone === "ok"
					? "bg-foreground ring-4 ring-muted/60"
					: "border-[1.5px] border-border",
			)}
		/>
	);
}

function MetaCell({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
	return (
		<div className="min-w-[120px] flex-1 border-r border-border/60 px-5 py-3 last:border-r-0">
			<div className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
				{k}
			</div>
			<div
				className={cn("mt-1.5 truncate text-[13px]", mono && "font-mono text-[11.5px]")}
			>
				{v}
			</div>
		</div>
	);
}
