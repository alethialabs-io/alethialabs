"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE DECISION SHEET (AGT-L2 spec §1.4; maintainer ruling 1 — decide in a sheet over the list, there
// is no separate approval page). It opens over `/{org}/~/approvals` whenever the URL names an
// approval (`?selected=<id>`): a row click, a link an agent or the CLI printed, or the legacy
// `/approvals/<id>` redirect. It reads the approval by id (`approvals.get`), never by finding its row
// in the list, so a deep link to a request on the list's third page opens without paging.
//
// LIVE WITHOUT POLLING. A decision, a use and a supersede fire the `environments` topic (the
// apply_approvals triggers), which invalidates `orpc.approvals.key()` (lib/query/topics.ts): a
// teammate's decision reaches this sheet and the row under it. Expiry is computed at read time and
// fires nothing, so a waiting sheet re-reads once when its window closes — one timer, not a poll —
// and on window focus.

import { formatRelative } from "@repo/format";
import { Button } from "@repo/ui/button";
import { copyText } from "@repo/ui/copy-text";
import { EmptyState } from "@repo/ui/empty";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@repo/ui/sheet";
import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Link2, Lock, X } from "lucide-react";
import { type RefObject, useEffect, useRef } from "react";
import { toast } from "sonner";
import { RegionError } from "@repo/ui/region-error";
import { useViewer } from "@/components/providers/viewer-provider";
import { orpc } from "@/lib/rpc/client";
import type { ApprovalSheet as ApprovalSheetData } from "@/lib/rpc/procedures/approvals";
import { readRefusalOf, retryUnlessRefused } from "@/lib/rpc/refusal";
import { ApprovalCountdown } from "./approval-countdown";
import { ApprovalDecision } from "./approval-decision";
import { ApprovalStatusBadge } from "./approval-marks";
import { NoteSection, PlanSection, RequestSection } from "./approval-sections";
import { approvalTitle, requesterName } from "./approval-vocabulary";

/** The only id shape `approvals.get` accepts; anything else is "not available" without a request. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Copies `href` and says so. */
async function copyLink(href: string): Promise<void> {
	if (await copyText(href)) toast.success("Link copied.");
	else toast.error("Couldn't copy the link. Copy it from the address bar instead.");
}

/** The props of {@link ApprovalSheet}. */
export interface ApprovalSheetProps {
	/** The approval the URL names, or null when the sheet is closed. */
	approvalId: string | null;
	orgSlug: string;
	/** Closes the sheet (removes `?selected=`). */
	onClose: () => void;
	/** Where focus returns on close: the row that opened the sheet, when one did. */
	returnFocus?: RefObject<HTMLElement | null>;
}

/**
 * The decision sheet: a modal dialog on the right (full screen on a phone), labelled by its title,
 * with focus starting on its close button and returning to the row that opened it. Escape and the
 * scrim close it; Escape inside the destroy confirmation closes only that.
 */
export function ApprovalSheet({ approvalId, orgSlug, onClose, returnFocus }: ApprovalSheetProps) {
	const closeRef = useRef<HTMLButtonElement | null>(null);
	const open = approvalId !== null;
	const valid = approvalId !== null && UUID.test(approvalId);
	const queryClient = useQueryClient();
	const sheet = useQuery({
		...orpc.approvals.get.queryOptions({ input: { id: approvalId ?? "" } }),
		enabled: valid,
		retry: retryUnlessRefused,
		refetchOnWindowFocus: true,
	});

	// Expiry fires no change hint: re-read once when a waiting request's window closes.
	const pendingUntil = sheet.data?.approval.status === "pending" ? sheet.data.approval.expires_at : null;
	useEffect(() => {
		if (!pendingUntil || !valid) return;
		const wait = Date.parse(pendingUntil) - Date.now();
		if (!(wait > 0)) return;
		const timer = setTimeout(() => void queryClient.invalidateQueries({ queryKey: orpc.approvals.key() }), wait + 1000);
		return () => clearTimeout(timer);
	}, [pendingUntil, valid, queryClient]);

	const data = sheet.data;
	// The loading state's Close is replaced when the read lands, and focus would fall to the page with
	// it: hand focus to the new Close so it stays in the dialog (spec §1.4, accessibility).
	const loaded = data !== undefined;
	useEffect(() => {
		if (!open || !loaded) return;
		const active = document.activeElement;
		if (active === null || active === document.body) closeRef.current?.focus();
	}, [open, loaded]);
	const pendingSerious =
		data && data.approval.status === "pending"
			? data.approval.operation === "destroy"
				? "destroy"
				: data.approval.environment_stage === "production"
					? "production"
					: null
			: null;

	return (
		<Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
			<SheetContent
				side="right"
				showCloseButton={false}
				initialFocus={closeRef}
				finalFocus={returnFocus}
				data-testid="approval-sheet"
				className={cn(
					"flex w-full flex-col gap-0 p-0 sm:max-w-[640px]",
					pendingSerious && "border-l-2 border-l-foreground",
				)}
			>
				{!valid || readRefusalOf(sheet.error) === "not-found" || readRefusalOf(sheet.error) === "forbidden" ? (
					<SheetFrame title="Approval" closeRef={closeRef}>
						<EmptyState
							data-state="not-available"
							icon={<Lock />}
							level={3}
							title="This approval isn't available to you"
							description="You may not have access to its project, or the link may be wrong. Ask the person who sent it."
							action={
								<Button variant="outline" size="sm" onClick={onClose}>
									Close
								</Button>
							}
						/>
					</SheetFrame>
				) : sheet.isError && !data ? (
					<SheetFrame title="Approval" closeRef={closeRef}>
						<RegionError
							title="Couldn't load this approval"
							description="Something went wrong on our side. Nothing was decided. Try again in a moment."
							onRetry={() => void sheet.refetch()}
						/>
					</SheetFrame>
				) : !data ? (
					<SheetFrame title="Loading approval" closeRef={closeRef} busy>
						<div className="space-y-4" data-state="loading">
							<Skeleton className="h-4 w-32" />
							<Skeleton className="h-6 w-3/4" />
							{Array.from({ length: 7 }, (_, i) => (
								<div key={i} className="flex gap-4">
									<Skeleton className="h-4 w-28" />
									<Skeleton className="h-4 w-1/2" />
								</div>
							))}
						</div>
					</SheetFrame>
				) : (
					<SheetBody
						data={data}
						orgSlug={orgSlug}
						serious={pendingSerious}
						closeRef={closeRef}
					/>
				)}
			</SheetContent>
		</Sheet>
	);
}

/** The close button every state carries: the dialog's own close, so it, Escape and the scrim agree. */
function CloseButton({ closeRef }: { closeRef: RefObject<HTMLButtonElement | null> }) {
	return (
		<SheetClose ref={closeRef} render={<Button variant="ghost" size="icon" aria-label="Close" />}>
			<X aria-hidden />
		</SheetClose>
	);
}

/** A sheet state with no approval to show (loading, error, not available): a title and a body. */
function SheetFrame({
	title,
	closeRef,
	busy = false,
	children,
}: {
	title: string;
	closeRef: RefObject<HTMLButtonElement | null>;
	busy?: boolean;
	children: React.ReactNode;
}) {
	return (
		<>
			<header className="flex items-start gap-3 border-b p-5">
				<SheetTitle className="min-w-0 flex-1 text-ui-xl">{title}</SheetTitle>
				<SheetDescription className="sr-only">An apply approval request.</SheetDescription>
				<CloseButton closeRef={closeRef} />
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto p-5" aria-busy={busy || undefined}>
				{children}
			</div>
		</>
	);
}

/** The loaded sheet: band, header, the three sections, and the pinned decision footer. */
function SheetBody({
	data,
	orgSlug,
	serious,
	closeRef,
}: {
	data: ApprovalSheetData;
	orgSlug: string;
	serious: "destroy" | "production" | null;
	closeRef: RefObject<HTMLButtonElement | null>;
}) {
	const { approval } = data;
	const { viewer } = useViewer();
	const title = approvalTitle(approval);
	const link = () => {
		const href = `${window.location.origin}/${orgSlug}/~/approvals?selected=${approval.id}`;
		void copyLink(href);
	};
	return (
		<>
			{serious ? (
				<div
					data-band={serious}
					className="flex items-center gap-2 bg-foreground px-5 py-2 font-mono text-ui-xs uppercase tracking-wide text-background"
				>
					<AlertTriangle aria-hidden className="size-3.5" />
					{serious === "destroy" ? "Destroy · can't be undone" : "Production environment"}
				</div>
			) : null}
			<header className="flex items-start gap-3 border-b p-5">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<ApprovalStatusBadge status={approval.status} />
						{approval.status === "pending" ? <ApprovalCountdown expiresAt={approval.expires_at} announce /> : null}
					</div>
					<SheetTitle className="mt-1.5 text-ui-xl text-text-primary">{title}</SheetTitle>
					<SheetDescription className="mt-0.5 text-ui-sm text-text-secondary">
						Requested {formatRelative(approval.created_at)} through {requesterName(approval)}.
					</SheetDescription>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<Button variant="ghost" size="icon" aria-label="Copy link" onClick={link}>
						<Link2 aria-hidden />
					</Button>
					<CloseButton closeRef={closeRef} />
				</div>
			</header>
			<div
				data-slot="approval-sheet-body"
				className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5"
			>
				<RequestSection approval={approval} />
				<PlanSection approval={approval} orgSlug={orgSlug} />
				<NoteSection approval={approval} />
			</div>
			<footer className="border-t p-5" data-slot="approval-decision">
				<ApprovalDecision sheet={data} orgSlug={orgSlug} viewerId={viewer?.id ?? null} onCopyLink={link} />
			</footer>
		</>
	);
}
