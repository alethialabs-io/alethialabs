"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useState } from "react";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
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
	Unlink,
	X,
} from "lucide-react";

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
	/** Rename a cloud account. */
	onRenameAccount: (identityId: string, name: string) => Promise<void>;
}

/**
 * The manage sheet for one connector. For clouds it lists every connected account
 * (each renamable / disconnectable) and offers "Add another account"; for git /
 * api_key connectors it offers connect or disconnect. Mutating affordances are
 * hidden unless `canManage`.
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
	onRenameAccount,
}: ConnectorDetailSheetProps) {
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [savingId, setSavingId] = useState<string | null>(null);

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
							<StatusBadge status="connected" label="Connected" />
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

					{/* Cloud accounts (multi-account) */}
					{isCloud && isConnected && (
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
													<div className="truncate text-xs font-medium text-foreground">
														{acc.name}
													</div>
													{acc.label && (
														<div className="truncate font-mono text-[10px] text-muted-foreground">
															{acc.label}
														</div>
													)}
												</div>
												{canManage && (
													<>
														<Button
															size="sm"
															variant="ghost"
															className="size-7 p-0 text-muted-foreground"
															onClick={() => startRename(acc.identityId, acc.name)}
														>
															<Pencil className="size-3.5" />
														</Button>
														<Button
															size="sm"
															variant="ghost"
															className="size-7 p-0 text-destructive hover:text-destructive"
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
