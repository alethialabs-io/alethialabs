"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useState } from "react";
import type {
	CloudAccountStatus,
	ConnectorWithConnection,
} from "@/app/server/actions/connectors";
import { ClassificationControl } from "@/components/classification/classification-control";
import { useAssignmentsForKind } from "@/lib/query/use-classification-query";
import { GitProviderIcon } from "@/components/connectors/git-provider-icon";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Separator } from "@repo/ui/separator";
import { StatusBadge } from "@repo/ui/status-badge";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import {
	BookOpen,
	Check,
	ExternalLink,
	Loader2,
	Pencil,
	Plus,
	RefreshCw,
	Unlink,
	X,
} from "lucide-react";

/**
 * The grayscale badge for one cloud account's health. `degraded` reads as `pending`, not `failed`:
 * the account authenticated fine and is usable — it just can't see everything we provision into, so
 * there is something left to do rather than something broken.
 */
function AccountStatusBadge({ status }: { status: CloudAccountStatus }) {
	switch (status) {
		case "connected":
			return <StatusBadge status="connected" label="Connected" />;
		case "degraded":
			return (
				<StatusBadge
					status="degraded"
					tier="pending"
					label="Limited permissions"
				/>
			);
		case "testing":
			return <StatusBadge status="testing" tier="pending" label="Verifying…" />;
		case "failed":
			return <StatusBadge status="failed" label="Verification failed" />;
	}
}

interface ConnectorDetailSheetProps {
	integration: ConnectorWithConnection | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	canManage: boolean;
	isConnecting?: boolean;
	/** Connect, or (for a connected cloud) add another account. */
	onConnect: () => void;
	/** Disconnect a non-cloud connector (git token / api_key credential). */
	onDisconnectConnector: () => void;
	/** Disconnect a specific cloud account by identity id. */
	onDisconnectAccount: (identityId: string) => void;
	/** Re-run verification for a specific cloud account against its stored credentials. */
	onReverifyAccount: (identityId: string) => Promise<void>;
	/** Rename a cloud account. */
	onRenameAccount: (identityId: string, name: string) => Promise<void>;
}

/**
 * The manage sheet for one connector. For clouds it lists every CONFIGURED account — including one
 * that failed to verify, which is the only place it can be re-verified or removed — each renamable /
 * disconnectable, and offers "Add another account"; for git / api_key connectors it offers connect or
 * disconnect. Mutating affordances are hidden unless `canManage`.
 */
export function ConnectorDetailSheet({
	integration,
	open,
	onOpenChange,
	canManage,
	isConnecting,
	onConnect,
	onDisconnectConnector,
	onDisconnectAccount,
	onReverifyAccount,
	onRenameAccount,
}: ConnectorDetailSheetProps) {
	const [reverifyingId, setReverifyingId] = useState<string | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [savingId, setSavingId] = useState<string | null>(null);

	// One batched query hydrates every connected account's classification chips.
	const accountIds = (integration?.accounts ?? []).map((a) => a.identityId);
	const { data: classMap = {} } = useAssignmentsForKind(
		"cloud_identity",
		accountIds,
	);

	if (!integration) return null;

	const isComingSoon = integration.status === "coming_soon";
	const isConnected = integration.connected;
	const isGit = integration.category === "git";
	const isCloud = integration.category === "cloud";
	const accounts = integration.accounts ?? [];

	const startRename = (id: string, current: string) => {
		setEditingId(id);
		setDraft(current);
	};

	const commitRename = async (id: string) => {
		const name = draft.trim();
		if (!name) return;
		setSavingId(id);
		try {
			await onRenameAccount(id, name);
			setEditingId(null);
		} finally {
			setSavingId(null);
		}
	};

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="w-full overflow-y-auto p-0 sm:max-w-md"
			>
				<SheetHeader className="border-b border-border/40 px-6 pb-4 pt-6">
					<div className="flex items-center gap-4">
						<div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/50 bg-background p-2">
							{isGit ? (
								<GitProviderIcon
									provider={integration.slug}
									size={28}
									mono={!isConnected}
								/>
							) : (
								<ConnectorIcon
									src={integration.icon_url}
									name={integration.name}
									size={32}
									mono={!isConnected}
								/>
							)}
						</div>
						<div>
							<SheetTitle className="text-base">
								{integration.name}
							</SheetTitle>
							<SheetDescription className="text-xs">
								{integration.organization}
							</SheetDescription>
						</div>
					</div>
				</SheetHeader>

				<div className="space-y-6 px-6 py-5">
					<div className="flex items-center gap-2">
						{isConnected ? (
							// Degraded still counts as connected — surface it here rather than reporting a
							// flat "Connected" over an account that can't see what we provision into.
							<AccountStatusBadge
								status={
									integration.cloud_health === "degraded" ? "degraded" : "connected"
								}
							/>
						) : isComingSoon ? (
							<Badge variant="secondary" className="text-xs">
								Coming Soon
							</Badge>
						) : (
							<Badge
								variant="outline"
								className="border-border/50 text-xs text-muted-foreground"
							>
								Not connected
							</Badge>
						)}
						{isConnected && integration.scope === "org" && (
							<Badge
								variant="outline"
								className="border-border/50 text-[10px] text-muted-foreground"
							>
								Org-wide
							</Badge>
						)}
					</div>

					<p className="text-sm leading-relaxed text-foreground/80">
						{integration.description}
					</p>

					{/* Cloud accounts (multi-account). Gated on the account list, NOT on `isConnected`: an
					    account whose verification failed is still listed here — it is the only place it can
					    be re-verified or removed, and while it was hidden a broken connection was stuck. */}
					{isCloud && accounts.length > 0 && (
						<div className="space-y-3">
							<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
								Accounts
							</h3>
							<div className="space-y-2">
								{accounts.map((acc) => (
									<div
										key={acc.identityId}
										className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2"
									>
										{editingId === acc.identityId ? (
											<>
												<Input
													value={draft}
													onChange={(e) => setDraft(e.target.value)}
													className="h-7 text-xs"
													autoFocus
													onKeyDown={(e) => {
														if (e.key === "Enter") commitRename(acc.identityId);
														if (e.key === "Escape") setEditingId(null);
													}}
												/>
												<Button
													size="sm"
													variant="ghost"
													className="size-7 p-0"
													disabled={savingId === acc.identityId}
													onClick={() => commitRename(acc.identityId)}
												>
													{savingId === acc.identityId ? (
														<Loader2 className="size-3.5 animate-spin" />
													) : (
														<Check className="size-3.5" />
													)}
												</Button>
												<Button
													size="sm"
													variant="ghost"
													className="size-7 p-0"
													onClick={() => setEditingId(null)}
												>
													<X className="size-3.5" />
												</Button>
											</>
										) : (
											<>
												<div className="min-w-0 flex-1">
													<div className="flex items-center gap-1.5">
														<span className="truncate text-xs font-medium text-foreground">
															{acc.name}
														</span>
														<AccountStatusBadge status={acc.status} />
													</div>
													{acc.label && (
														<div className="truncate font-mono text-[10px] text-muted-foreground">
															{acc.label}
														</div>
													)}
													{/* Why it failed / what it can't see. Without this the only signal was a
													    generic red badge, and the fix was a guess. */}
													{acc.status === "failed" && acc.lastError && (
														<p className="mt-1 text-[10px] leading-relaxed text-destructive">
															{acc.lastError}
														</p>
													)}
													{acc.status === "degraded" &&
														(acc.missingPermissions?.length ?? 0) > 0 && (
															<p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
																Missing:{" "}
																<span className="font-mono">
																	{acc.missingPermissions?.join(", ")}
																</span>
															</p>
														)}
													{/* Classification (Workstream B) — chips + a picker for managers. */}
													<ClassificationControl
														kind="cloud_identity"
														id={acc.identityId}
														canEdit={canManage}
														initialAssignments={classMap[acc.identityId]}
														className="mt-1.5"
														compact
													/>
												</div>
												{canManage && (
													<>
														{(acc.status === "failed" || acc.status === "degraded") && (
															<Button
																size="sm"
																variant="ghost"
																className="size-7 p-0 text-muted-foreground"
																title="Re-verify with the stored credentials"
																disabled={reverifyingId === acc.identityId}
																onClick={async () => {
																	setReverifyingId(acc.identityId);
																	try {
																		await onReverifyAccount(acc.identityId);
																	} finally {
																		setReverifyingId(null);
																	}
																}}
															>
																{reverifyingId === acc.identityId ? (
																	<Loader2 className="size-3.5 animate-spin" />
																) : (
																	<RefreshCw className="size-3.5" />
																)}
															</Button>
														)}
														<Button
															size="sm"
															variant="ghost"
															className="size-7 p-0 text-muted-foreground"
															title="Rename"
															onClick={() => startRename(acc.identityId, acc.name)}
														>
															<Pencil className="size-3.5" />
														</Button>
														<Button
															size="sm"
															variant="ghost"
															className="size-7 p-0 text-destructive hover:text-destructive"
															title="Remove this connection"
															onClick={() => onDisconnectAccount(acc.identityId)}
														>
															<Unlink className="size-3.5" />
														</Button>
													</>
												)}
											</>
										)}
									</div>
								))}
							</div>
							{canManage && (
								<Button
									variant="outline"
									size="sm"
									className="w-full border-border/50 text-xs"
									disabled={isConnecting}
									onClick={onConnect}
								>
									{isConnecting ? (
										<Loader2 className="mr-1.5 size-3.5 animate-spin" />
									) : (
										<Plus className="mr-1.5 size-3.5" />
									)}
									Add another account
								</Button>
							)}
						</div>
					)}

					<Separator />

					{(integration.docs_url || integration.support_url) && (
						<div className="space-y-1">
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
						</div>
					)}

					{/* Classification (Workstream B) — for a connected non-cloud credential. */}
					{isConnected && !isCloud && integration.credential_id && (
						<div className="space-y-2">
							<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
								Classification
							</h3>
							<ClassificationControl
								kind="connector_credential"
								id={integration.credential_id}
								canEdit={canManage}
							/>
						</div>
					)}

					{/* Connect (any not-connected connector) / disconnect (non-cloud) */}
					{!isComingSoon && canManage && !isConnected && (
						<Button
							className="w-full"
							disabled={isConnecting}
							onClick={onConnect}
						>
							{isConnecting && <Loader2 className="mr-2 size-4 animate-spin" />}
							Connect {integration.name}
						</Button>
					)}
					{!isComingSoon && canManage && isConnected && !isCloud && (
						<Button
							variant="outline"
							className="w-full border-border/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
							onClick={onDisconnectConnector}
						>
							<Unlink className="mr-2 size-4" />
							Disconnect {integration.name}
						</Button>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
