"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import type {
	CloudAccount,
	CloudAccountStatus,
	ConnectorWithConnection,
} from "@/app/server/actions/connectors";
import { renameCloudAccount } from "@/app/server/actions/identities";
import { ClassificationControl } from "@/components/classification/classification-control";
import { useAssignmentsForKind } from "@/lib/query/use-classification-query";
import { GitProviderIcon } from "@/components/connectors/git-provider-icon";
import { ConnectorIcon, isThirdPartyMark } from "@/components/connectors/connector-icon";
import { connectorKeys } from "@/components/connectors/connectors-board";
import {
	connectorState,
	notOfferedSentence,
	type ConnectorHealth,
} from "@/components/connectors/connectors-query";
import { MANAGE_DENIED_REASON } from "@/components/errors/manage-gate";
import { FormRootError } from "@/components/forms/form-root-error";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { CLOUD_ACCOUNT, sentenceStart } from "@/lib/copy/vocabulary";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { DetailSheet } from "@repo/ui/detail-sheet";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@repo/ui/form";
import { Input } from "@repo/ui/input";
import { SectionHeading } from "@repo/ui/section-heading";
import { Separator } from "@repo/ui/separator";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import {
	BookOpen,
	Check,
	ExternalLink,
	Pencil,
	Plus,
	RefreshCw,
	Unlink,
	X,
} from "lucide-react";

/**
 * How each cloud-account health renders through the shared `StatusBadge`. This used to be a
 * file-local `AccountStatusBadge` component — one of the console's ad-hoc status pills — but
 * all it ever contributed was a tier override and a label, so it is data now rather than a
 * component wrapping the shared one.
 *
 * `degraded` deliberately reads as `pending`, not `failed`: the account authenticated fine and
 * is usable — it just cannot see everything we provision into, so there is something left to
 * do rather than something broken.
 */
const ACCOUNT_BADGE: Record<
	CloudAccountStatus,
	{ tier?: StatusTier; label: string }
> = {
	connected: { label: "Connected" },
	degraded: { tier: "pending", label: "Limited permissions" },
	testing: { tier: "pending", label: "Verifying…" },
	failed: { label: "Verification failed" },
};

/** Grayscale tier for the connector-level rollup shown in the sheet header. */
const HEALTH_TIER: Record<ConnectorHealth, StatusTier> = {
	connected: "active",
	attention: "pending",
	disconnected: "idle",
	unavailable: "disabled",
	coming_soon: "disabled",
};

/**
 * A cloud account's name, as the rename form accepts it. The same two limits the server applies
 * (`renameCloudAccount`), so an empty or over-long name is answered under the field before any
 * request is made. An empty name used to make Save do nothing, with no message.
 */
const renameSchema = z.object({
	name: z
		.string()
		.trim()
		.min(1, "Name cannot be empty.")
		.max(120, "Keep the name under 120 characters."),
});

type RenameValues = z.infer<typeof renameSchema>;

/**
 * The inline form that renames one cloud account: a field, Save and Cancel. Save is pending while
 * the rename runs and cannot be pressed twice; a refusal about the name lands under the field and
 * any other in the form's own error line, and the form stays open with what was typed. It closes
 * itself (`onDone`) once the rename has succeeded, or at once when the name was not changed.
 */
function AccountRenameForm({ account, onDone }: { account: CloudAccount; onDone: () => void }) {
	const form = useForm<RenameValues>({
		resolver: zodResolver(renameSchema),
		defaultValues: { name: account.name },
	});
	const rename = useActionMutation(renameCloudAccount, {
		invalidates: connectorKeys(),
		form: { instance: form, fields: ["name"] },
		successMessage: `${sentenceStart(CLOUD_ACCOUNT.one)} renamed.`,
		onSuccess: onDone,
	});

	/** Sends the new name, or just closes the form when it is the name the account already has. */
	const submit = form.handleSubmit((values) => {
		if (values.name === account.name) {
			onDone();
			return;
		}
		rename.submit({ identityId: account.identityId, name: values.name });
	});

	return (
		<Form {...form}>
			<form onSubmit={submit} noValidate className="min-w-0 flex-1 space-y-1.5">
				<FormField
					control={form.control}
					name="name"
					render={({ field }) => (
						<FormItem className="space-y-1.5">
							<div className="flex items-center gap-2">
								{/* Named, all three: the row's only text input and its two icon-only
								    buttons. Exactly one account can be editing, so these names are unique
								    on the page without carrying the account in them. */}
								<FormControl>
									<Input
										{...field}
										className="h-7 text-xs"
										aria-label="Account name"
										autoComplete="off"
										autoFocus
										disabled={rename.isPending}
										onKeyDown={(event) => {
											if (event.key === "Escape") onDone();
										}}
									/>
								</FormControl>
								<Button
									type="submit"
									size="sm"
									variant="ghost"
									className="size-7 shrink-0 p-0"
									title="Save name"
									aria-label={rename.isPending ? "Renaming…" : "Save name"}
									pending={rename.isPending}
								>
									<Check className="size-3.5" aria-hidden />
								</Button>
								<Button
									type="button"
									size="sm"
									variant="ghost"
									className="size-7 shrink-0 p-0"
									title="Cancel rename"
									aria-label="Cancel rename"
									disabled={rename.isPending}
									onClick={onDone}
								>
									<X className="size-3.5" aria-hidden />
								</Button>
							</div>
							<FormMessage className="text-ui-2xs" />
						</FormItem>
					)}
				/>
				<FormRootError form={form} />
			</form>
		</Form>
	);
}

interface ConnectorDetailSheetProps {
	integration: ConnectorWithConnection | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Whether the viewer may add, re-verify, rename or remove connections. */
	canManage: boolean;
	/** False when this instance lacks the platform creds/OAuth app this connector's flow needs. */
	platformConfigured?: boolean;
	/**
	 * False for a cloud that takes no new connection on this deployment (`acceptsNewConnections`).
	 * Its accounts keep Re-verify, Rename and Disconnect; "Add another account" is not offered, and
	 * one sentence says why. Defaults to true.
	 */
	offered?: boolean;
	isConnecting?: boolean;
	/** Connect, or (for a connected cloud) add another account. */
	onConnect: () => void;
	/** Disconnect a non-cloud connector (git link / api_key credential). */
	onDisconnectConnector: () => void;
	/** Disconnect a specific cloud account by identity id. */
	onDisconnectAccount: (identityId: string) => void;
	/** Re-run verification for a specific cloud account against its stored configuration. */
	onReverifyAccount: (identityId: string) => Promise<void>;
}

/**
 * The manage drawer for one connector, on the shared `DetailSheet` shell (header title +
 * description + status badge, an independently scrolling body, a pinned footer action).
 *
 * For clouds it lists every CONFIGURED account — including one that failed to verify, which is
 * the only place it can be re-verified or removed — each with Re-verify, Rename and Disconnect, and
 * offers "Add another account"; for git / api_key connectors the footer offers connect or
 * disconnect.
 *
 * A viewer who may not manage connections reads the same sheet. Every control that would change
 * something is drawn disabled with the reason (`DisabledReason`), and one line at the top says the
 * sheet is read-only for them, so the row of disabled controls is not the only signal.
 */
export function ConnectorDetailSheet({
	integration,
	open,
	onOpenChange,
	canManage,
	platformConfigured = true,
	offered = true,
	isConnecting,
	onConnect,
	onDisconnectConnector,
	onDisconnectAccount,
	onReverifyAccount,
}: ConnectorDetailSheetProps) {
	const [reverifyingId, setReverifyingId] = useState<string | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);

	// One batched query hydrates every connected account's classification chips.
	const accountIds = (integration?.accounts ?? []).map((a) => a.identityId);
	const { data: classMap = {} } = useAssignmentsForKind(
		"cloud_identity",
		accountIds,
	);

	if (!integration) return null;

	const isConnected = integration.connected;
	const state = connectorState(integration, platformConfigured);
	// "Coming soon" only when NOT already connected, so a connected account still shows its
	// accounts + disconnect UI rather than a dead "Coming Soon" badge. See connector-card.tsx.
	const isComingSoon = state.health === "coming_soon";
	const isGit = integration.category === "git";
	const isCloud = integration.category === "cloud";
	const accounts = integration.accounts ?? [];
	const denied = canManage ? null : MANAGE_DENIED_REASON;

	const logo = isGit ? (
		<GitProviderIcon provider={integration.slug} size={20} mono={false} />
	) : (
		<ConnectorIcon
			src={integration.icon_url}
			name={integration.name}
			size={22}
			mono={!isConnected && !isThirdPartyMark(integration.icon_url)}
			canLink
		/>
	);

	// The pinned action. A cloud with accounts adds another (per-account disconnect lives on the
	// row) — unless the cloud takes no new connection, when there is no pinned action at all;
	// everything else connects or disconnects wholesale.
	let footer: React.ReactNode = null;
	if (!isComingSoon) {
		if (isCloud && accounts.length > 0) {
			footer = offered ? (
				<DisabledReason reason={denied} className="flex w-full">
					<Button
						variant="outline"
						className="w-full border-border/50 text-xs"
						pending={isConnecting}
						onClick={onConnect}
					>
						<Plus className="mr-1.5 size-3.5" aria-hidden />
						{isConnecting ? "Connecting…" : "Add another account"}
					</Button>
				</DisabledReason>
			) : null;
		} else if (!isConnected) {
			footer =
				offered && state.health !== "unavailable" ? (
					<DisabledReason reason={denied} className="flex w-full">
						<Button className="w-full" pending={isConnecting} onClick={onConnect}>
							{isConnecting ? `Connecting ${integration.name}…` : `Connect ${integration.name}`}
						</Button>
					</DisabledReason>
				) : null;
		} else if (!isCloud) {
			footer = (
				<DisabledReason reason={denied} className="flex w-full">
					<Button
						variant="outline"
						className="w-full border-border/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
						onClick={onDisconnectConnector}
					>
						<Unlink className="mr-2 size-4" aria-hidden />
						Disconnect {integration.name}
					</Button>
				</DisabledReason>
			);
		}
	}

	return (
		<DetailSheet
			open={open}
			onOpenChange={onOpenChange}
			className="w-full sm:max-w-md"
			title={
				<span className="flex min-w-0 items-center gap-2.5">
					<span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/50 bg-background p-1.5">
						{logo}
					</span>
					<span className="truncate">{integration.name}</span>
				</span>
			}
			description={integration.organization}
			badge={
				<StatusBadge
					status={state.health}
					tier={HEALTH_TIER[state.health]}
					label={state.label}
				/>
			}
			footer={footer}
		>
			<div className="space-y-6">
				{/* Why this cloud's card looks different from its neighbours: it takes no new
				    connection. Said once, in words, above the accounts it is about. */}
				{!offered && (
					<p
						role="note"
						data-slot="connector-not-offered"
						className="rounded-md border px-3 py-2 text-ui-sm leading-relaxed text-text-secondary"
					>
						{notOfferedSentence(integration.name)}
					</p>
				)}

				{!canManage && (
					<p
						role="note"
						data-slot="connector-read-only"
						className="rounded-md border px-3 py-2 text-ui-sm leading-relaxed text-text-secondary"
					>
						You can see this connection but not change it. {MANAGE_DENIED_REASON}
					</p>
				)}

				{isConnected && integration.scope === "org" && (
					<Badge
						variant="outline"
						className="border-border/50 text-ui-2xs text-muted-foreground"
					>
						Org-wide
					</Badge>
				)}

				<p className="text-sm leading-relaxed text-muted-foreground">
					{integration.description}
				</p>

				{/* Cloud accounts (multi-account). Gated on the account list, NOT on `isConnected`: an
				    account whose verification failed is still listed here — it is the only place it can
				    be re-verified or removed, and while it was hidden a broken connection was stuck. */}
				{isCloud && accounts.length > 0 && (
					<div className="space-y-3">
						<SectionHeading level={3} title={sentenceStart(CLOUD_ACCOUNT.many)} />
						<div className="space-y-2">
							{accounts.map((acc) => (
								<div
									key={acc.identityId}
									className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2"
								>
									{editingId === acc.identityId ? (
										<AccountRenameForm account={acc} onDone={() => setEditingId(null)} />
									) : (
										<>
											<div className="min-w-0 flex-1">
												<div className="flex flex-wrap items-center gap-1.5">
													<span className="truncate text-xs font-medium text-foreground">
														{acc.name}
													</span>
													<StatusBadge
														status={acc.status}
														{...ACCOUNT_BADGE[acc.status]}
													/>
												</div>
												{acc.label && (
													<div className="truncate font-mono text-ui-2xs text-muted-foreground">
														{acc.label}
													</div>
												)}
												{/* Why it failed / what it can't see. Without this the only signal was a
												    generic red badge, and the fix was a guess. */}
												{acc.status === "failed" && acc.lastError && (
													<p className="mt-1 text-ui-2xs leading-relaxed text-destructive">
														{acc.lastError}
													</p>
												)}
												{acc.status === "degraded" &&
													(acc.missingPermissions?.length ?? 0) > 0 && (
														<p className="mt-1 text-ui-2xs leading-relaxed text-muted-foreground">
															Missing:{" "}
															<span className="font-mono">
																{acc.missingPermissions?.join(", ")}
															</span>
														</p>
													)}
												{/* Classification (Workstream B) — chips + a picker for managers. `label`
												    carries the account into the compact trigger's accessible name for the
												    same reason the three buttons below do: a cloud can hold several
												    accounts, and a bare "Classify" repeated down the list would be one
												    unlabelled command per row (#4490). */}
												<ClassificationControl
													kind="cloud_identity"
													id={acc.identityId}
													canEdit={canManage}
													initialAssignments={classMap[acc.identityId]}
													className="mt-1.5"
													compact
													label={acc.name}
												/>
											</div>
											{/* Each account's three icon buttons name THAT ACCOUNT. A cloud can hold
											    several, and a `title` of "Rename" repeated down the list says which
											    verb but never which row. The verb stays the first word, so the
											    tooltip still reads as an action.

											    All three are drawn for every viewer. One who may not manage
											    connections gets them disabled with the reason; they are not removed,
											    because a row with no controls reads as a row nothing can be done to.

											    Re-verify is offered whatever the account's status: a role that was
											    changed in the cloud is checked from here, not only one that already
											    failed. */}
											<DisabledReason reason={denied}>
												<Button
													size="sm"
													variant="ghost"
													className="size-7 p-0 text-muted-foreground"
													title={`Re-verify ${acc.name} with the stored configuration`}
													aria-label={
														reverifyingId === acc.identityId
															? `Re-verifying ${acc.name}…`
															: `Re-verify ${acc.name}`
													}
													pending={reverifyingId === acc.identityId}
													disabled={acc.status === "testing"}
													onClick={async () => {
														setReverifyingId(acc.identityId);
														try {
															await onReverifyAccount(acc.identityId);
														} finally {
															setReverifyingId(null);
														}
													}}
												>
													<RefreshCw className="size-3.5" aria-hidden />
												</Button>
											</DisabledReason>
											<DisabledReason reason={denied}>
												<Button
													size="sm"
													variant="ghost"
													className="size-7 p-0 text-muted-foreground"
													title={`Rename ${acc.name}`}
													aria-label={`Rename ${acc.name}`}
													onClick={() => setEditingId(acc.identityId)}
												>
													<Pencil className="size-3.5" aria-hidden />
												</Button>
											</DisabledReason>
											<DisabledReason reason={denied}>
												<Button
													size="sm"
													variant="ghost"
													className="size-7 p-0 text-destructive hover:text-destructive"
													title={`Disconnect ${acc.name}`}
													aria-label={`Disconnect ${acc.name}`}
													onClick={() => onDisconnectAccount(acc.identityId)}
												>
													<Unlink className="size-3.5" aria-hidden />
												</Button>
											</DisabledReason>
										</>
									)}
								</div>
							))}
						</div>
					</div>
				)}

				<Separator />

				{integration.docs_url && (
					<a
						href={integration.docs_url}
						target="_blank"
						rel="noopener noreferrer"
						className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
					>
						<BookOpen className="size-4" />
						Documentation
						<ExternalLink className="ml-auto size-3" />
					</a>
				)}

				{/* Classification (Workstream B) — for a connected non-cloud credential. */}
				{isConnected && !isCloud && integration.credential_id && (
					<div className="space-y-2">
						<SectionHeading level={3} title="Classification" />
						<ClassificationControl
							kind="connector_credential"
							id={integration.credential_id}
							canEdit={canManage}
						/>
					</div>
				)}
			</div>
		</DetailSheet>
	);
}
