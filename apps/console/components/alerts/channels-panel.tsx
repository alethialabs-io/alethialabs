"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alerts hub · Channels panel. A master-detail: a rail of channels + an inline detail.
// Adding a channel opens the guided ChannelSheet (which verifies before creating); existing
// channels edit in place (no edit button) with a dirty Save/Discard bar, a standalone
// enable switch that confirms on disable, the unified ChannelVerify re-verify control, and
// a confirmed Delete. "Used by" cross-links into the Policies section.
//
// Every write goes through `useActionMutation` (#6125) — pending state on its trigger, one toast
// for a refusal, and invalidation of every key that shows alert data. The panel's body follows the
// view's READ STATE: a skeleton while the first answer is in flight, a region error when it failed,
// "No channels yet" only once the org's channels were read and there are none.

import { Plus, SearchX, Send, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import {
	type ChannelDTO,
	deleteChannel,
	type PolicyDTO,
	setChannelEnabled,
	updateChannel,
} from "@/app/server/actions/alerts";
import type { AlertsHub } from "@/components/alerts/alerts-hub";
import { AlertsPanelSkeleton } from "@/components/alerts/alerts-skeleton";
import { RegionError } from "@/components/errors/region-error";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { alertsKeys } from "@/lib/query/use-alerts-query";
import { ChannelIcon } from "@/components/alerts/channel-icon";
import { ChannelsFilterBar } from "@/components/alerts/alerts-filter-bar";
import type { ChannelsView } from "@/components/alerts/alerts-filters";
import { channelBadge, policyBadge } from "@/components/alerts/alerts-status";
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
import { useAlertChannelFilters } from "@/lib/stores/use-alerts-filters";
import { useAlertsSection } from "@/lib/stores/use-alerts-section";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { StatusBadge } from "@repo/ui/status-badge";
import { Switch } from "@repo/ui/switch";
import { cn } from "@repo/ui/utils";

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
	hub: AlertsHub;
	/** The filter standard's resolved view — rows, facets, read state, active-filter count. */
	view: ChannelsView;
	onOpenPolicy: (id?: string) => void;
}

/** Channels master-detail. */
export function ChannelsPanel({ hub, view, onOpenPolicy }: ChannelsPanelProps) {
	const { channels, policies, canManage, encryptionConfigured } = hub;
	const selectedId = useAlertsSection((s) => s.selectedChannelId);
	const setSelectedId = useAlertsSection((s) => s.setSelectedChannelId);

	const [sheetOpen, setSheetOpen] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState<ChannelDTO | null>(null);

	const selected =
		channels.find((c) => c.id === selectedId) ?? channels[0] ?? null;
	// One batched query hydrates every channel row's classification chips.
	const { data: classMap = {} } = useAssignmentsForKind(
		"alert_channel",
		channels.map((c) => c.id),
	);
	const { rows, facets, stale } = view;
	const resetFilters = useAlertChannelFilters((s) => s.reset);

	const remove = useActionMutation(deleteChannel, {
		invalidates: alertsKeys(),
		successMessage: "Channel deleted",
		onSuccess: () => {
			setSelectedId(null);
			setDeleteTarget(null);
		},
	});

	const addBtn = canManage && (
		<Button size="sm" onClick={() => setSheetOpen(true)}>
			<Plus className="mr-1 size-3.5" /> Add channel
		</Button>
	);

	const policiesUsing = (id: string) =>
		policies.filter((p) => p.channelIds.includes(id));

	return (
		<div>
			{view.state === "loading" ? (
				<AlertsPanelSkeleton kind="channels" />
			) : view.state === "error" ? (
				<RegionError title="Couldn't load channels" onRetry={view.retry} />
			) : view.total === 0 ? (
				<EmptyState
					icon={<Send />}
					// `level={3}` under the section's own `h2`. EmptyState renders its title as a
					// plain `<div>` by default (correct inside a card or a table cell), and this
					// state heads the whole Channels region — so without the level the heading the
					// hand-rolled empty state used to carry is silently dropped from the outline,
					// which is the regression EmptyState's own docstring warns about.
					level={3}
					title="No channels yet"
					description={`Channels are where alerts get delivered — Slack, email, Rocket.Chat or a signed webhook.${canManage ? " Add one to start." : ""}`}
					action={canManage ? addBtn : undefined}
				/>
			) : (
				<>
					<ChannelsFilterBar facets={facets} action={addBtn} />

					{/* master-detail */}
					<div className="flex flex-wrap items-start gap-4">
						{/* The filter standard's `isPlaceholderData` dim: while `stale` is true these rows are
						    the PREVIOUS query's answer, kept so the rail does not blank on a filter change
						    and marked so they are not read as the current one. */}
						<div
							className={cn(
								"min-w-[290px] flex-1 overflow-hidden rounded-xl border border-border/60 bg-background shadow-sm",
								stale && "opacity-60 transition-opacity",
							)}
						>
							<div className="px-4 py-3 font-mono text-ui-3xs uppercase tracking-[0.14em] text-text-tertiary">
								Configured channels
							</div>
							{rows.length === 0 ? (
								// The shared empty state, not a line of muted text: the zero-result answer
								// is the same component on every console list, and it carries the way out
								// (the audit's F10 reads `[data-slot="empty"]` for exactly this, #4939).
								<EmptyState
									icon={<SearchX />}
									title="No channels match"
									description={`None of the ${view.total} channels match these filters.`}
									action={
										<Button variant="outline" size="sm" onClick={resetFilters}>
											Reset filters
										</Button>
									}
								/>
							) : (
								/*
								 * A single-select rail, so it is a listbox of options — not a stack of
								 * buttons. Two things turn on that: a screen reader gets "3 of 7,
								 * selected" instead of seven unrelated buttons, and the rail row for a
								 * channel stops COLLIDING by role with the "Used by" pill that names the
								 * same resource in the detail beside it. The listbox wraps only the rows
								 * (the "Configured channels" caption stays outside it) because a
								 * listbox's children must all be options.
								 */
								<div role="listbox" aria-label="Configured channels">
									{rows.map((c) => (
										<ChannelRow
											key={c.id}
											channel={c}
											selected={selected?.id === c.id}
											onSelect={() => setSelectedId(c.id)}
											assignments={classMap[c.id]}
										/>
									))}
								</div>
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
					encryptionConfigured={encryptionConfigured}
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
				pendingLabel="Deleting…"
				pending={remove.isPending}
				onConfirm={() => {
					if (deleteTarget && !remove.isPending) remove.mutate({ id: deleteTarget.id });
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
			role="option"
			aria-selected={selected}
			onClick={onSelect}
			className={cn(
				"flex w-full items-center gap-3 border-b border-l-2 border-border/60 px-3.5 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/40",
				selected ? "border-l-foreground bg-muted/40" : "border-l-transparent",
			)}
		>
			<ChannelTile type={channel.type} active={channel.is_verified} />
			<span className="min-w-0 flex-1">
				<span className="block truncate font-medium text-ui-md">
					{channel.name}
				</span>
				<span className="truncate font-mono text-ui-2xs text-muted-foreground">
					{targetOf(channel)}
				</span>
				<ClassificationChips
					kind="alert_channel"
					id={channel.id}
					initialAssignments={assignments}
					className="mt-1 flex"
				/>
			</span>
			<StatusBadge {...channelBadge(channel)} showLabel={false} />
		</button>
	);
}

interface ChDetailProps {
	channel: ChannelDTO;
	canManage: boolean;
	encryptionConfigured: boolean;
	usingPolicies: PolicyDTO[];
	onRequestDelete: () => void;
	onOpenPolicy: (id?: string) => void;
}

function ChannelDetail({
	channel,
	canManage,
	encryptionConfigured,
	usingPolicies,
	onRequestDelete,
	onOpenPolicy,
}: ChDetailProps) {
	const meta = CHANNEL_TYPE_META[channel.type];

	// Directly-editable draft (no edit-mode toggle). Reset whenever the channel changes.
	const [name, setName] = useState(channel.name);
	const [recipients, setRecipients] = useState<string[]>(channel.recipients);
	const [url, setUrl] = useState("");
	const [secret, setSecret] = useState("");
	// Each credential field's `id`, paired with its `<Label htmlFor>` so the label names it.
	const routingKeyId = useId();
	const urlId = useId();
	const secretId = useId();
	const [routingKey, setRoutingKey] = useState("");
	const [disableConfirm, setDisableConfirm] = useState(false);

	const update = useActionMutation(updateChannel, {
		invalidates: alertsKeys(),
		successMessage: "Channel saved",
		onSuccess: () => {
			setUrl("");
			setSecret("");
			setRoutingKey("");
		},
	});
	const toggle = useActionMutation(setChannelEnabled, {
		invalidates: alertsKeys(),
		onSuccess: () => setDisableConfirm(false),
	});
	const saving = update.isPending;
	const togglePending = toggle.isPending;

	// Reset the draft when the SAVED values change — not whenever the row object does. The row is a
	// query result now, and every live refetch (any alert hint: a delivery, another member's toggle)
	// hands back a new object; resetting on identity would throw away an edit in progress each time.
	const saved = JSON.stringify([channel.name, channel.recipients]);
	const [savedSeen, setSavedSeen] = useState(saved);
	if (saved !== savedSeen) {
		setSavedSeen(saved);
		setName(channel.name);
		setRecipients(channel.recipients);
		setUrl("");
		setSecret("");
		setRoutingKey("");
	}

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

	const save = () => {
		if (saving) return;
		if (channel.type === "email" && recipients.length === 0)
			return toast.error("Add at least one recipient.");
		update.mutate({
				id: channel.id,
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
	};

	const applyEnabled = (next: boolean) => {
		if (togglePending) return;
		toggle.mutate({ id: channel.id, enabled: next });
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
							<>
								{/*
								 * The detail header's name field is a real, editable input and was
								 * reachable only through its placeholder — which is not a label: it
								 * disappears the moment the field has a value, which for this field is
								 * always. The label is visually hidden because the field's own text IS
								 * the heading of the panel, so painting "Channel name" above it would
								 * say the same thing twice.
								 */}
								<Label htmlFor={`channel-name-${channel.id}`} className="sr-only">
									Channel name
								</Label>
								<Input
									id={`channel-name-${channel.id}`}
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="Channel name"
									className="h-8 w-64 font-display font-semibold text-lg"
								/>
							</>
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
				<StatusBadge {...channelBadge(channel)} className="flex-none text-ui-2xs" />
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
					<span className="font-mono text-ui-2xs uppercase tracking-wider text-muted-foreground">
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
						<Label htmlFor={routingKeyId}>Integration routing key</Label>
						{canManage ? (
							<Input
								id={routingKeyId}
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
							<Label htmlFor={urlId}>
								{channel.type === "webhook"
									? "Payload URL"
									: `${meta.name} webhook URL`}
							</Label>
							{canManage ? (
								<Input
									id={urlId}
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
									<Label htmlFor={secretId}>Signing secret</Label>
									<FieldHelp title="Signing secret">
										Optional. If set, Alethia signs each request body and sends{" "}
										<code className="font-mono">X-Alethia-Signature: sha256=…</code>{" "}
										so your receiver can verify the request came from Alethia.
									</FieldHelp>
								</div>
								<Input
									id={secretId}
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
					{/*
					 * The name is "Enabled" in BOTH states — it names the control, not the state,
					 * which `aria-checked` already carries. It is also the name
					 * `apps/console/destructive-actions.yaml` records for `alerts.channel.disable`
					 * (`control: { role: switch, name: "Enabled" }`), which until now was a claim
					 * about a switch that announced nothing at all.
					 */}
					<Switch
						aria-label="Enabled"
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
				/>
			</div>

			{/* used by */}
			<div className="space-y-3 border-b border-border/60 p-5">
				<div className="flex items-center gap-2">
					<span className="font-mono text-ui-2xs uppercase tracking-wider text-muted-foreground">
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
								<StatusBadge {...policyBadge(p)} showLabel={false} />
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
				pendingLabel="Disabling…"
				pending={togglePending}
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

function MetaCell({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
	return (
		<div className="min-w-[120px] flex-1 border-r border-border/60 px-5 py-3 last:border-r-0">
			<div className="font-mono text-ui-3xs uppercase tracking-wider text-muted-foreground">
				{k}
			</div>
			<div
				className={cn("mt-1.5 truncate text-ui-md", mono && "font-mono text-ui-xs")}
			>
				{v}
			</div>
		</div>
	);
}
