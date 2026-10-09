"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A draft's status, rendered into the composer's two mount points (ADR 0001 §7.2, §7.4, §14 slice
// 11). The composer renders both wherever it is mounted (the modal landing and the docked chat).
//
// - `DraftBarSlot`, above the box: the bar of whatever holds the box or needs the user's decision
//   (a send in flight, another tab's claim, a conflict, a copy that came back, a message that may
//   already have been sent, a credential-looking paste), then the lines the store raised since this
//   draft's last send (a refused send's reason, where the words are). A bar that asks for a decision
//   is an `alert`, so it is announced at once; its actions are buttons in the tab order just above
//   the box, and each one hands focus back to the box when it is done.
// - `DraftFooterSlot`, under the box: the key's save state. It says "Saved" for 2 s after the server
//   acknowledged exactly what the box shows, and never otherwise.
//
// Both are `role="status"` regions that stay mounted while empty, so a line that appears is
// announced. The words themselves are `copy.ts`'s.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { keyId } from "@/lib/stores/elench-drafts/reducer-drafting";
import type { DraftsStoreHandle, DraftsView } from "@/lib/stores/elench-drafts/store";
import type { DraftEntry, DraftEntryEvent, DraftKey } from "@/lib/stores/elench-drafts/types";
import type { DraftSendEvent } from "@/lib/stores/elench-drafts/reducer-sending";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import { Button } from "@repo/ui/button";
import { StatusBadge } from "@repo/ui/status-badge";
import { useElenchDraft } from "../use-elench-send";
import {
	barOf,
	barText,
	COPY,
	type DraftBar,
	footerOf,
	heldOtherOrgText,
	isAcknowledged,
	noticeLines,
} from "./copy";
import { forgetKeptInTab, keepInTab, useKeptInTab, useSavedAt } from "./registry";

/** Where one draft's status is rendered: the key it reports on. */
export interface DraftSlotProps {
	draftKey: DraftKey;
}

/** How long the footer says "Saved" after an acknowledgement (§7.4). */
export const SAVED_SHOWN_MS = 2_000;

/** Subscribes to nothing: without a draft the view never changes. */
function subscribeNothing(): () => void {
	return () => undefined;
}

/** The store's view, re-rendering on its every change; null without a draft. */
function useDraftsView(store: DraftsStoreHandle | null): DraftsView | null {
	const subscribe = useCallback(
		(onChange: () => void) => (store === null ? subscribeNothing() : store.view.subscribe(onChange)),
		[store],
	);
	const snapshot = useCallback(() => (store === null ? null : store.view.getState()), [store]);
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Moves focus back into the composer's box next to `from` (the slot sits beside it). */
function focusBox(from: HTMLElement | null): void {
	from?.parentElement?.querySelector<HTMLElement>('[data-testid="elench-composer"]')?.focus();
}

// ── The bar ─────────────────────────────────────────────────────────────────────────────────

/** One action of a bar. */
interface BarAction {
	label: string;
	run: () => void;
}

/** The actions a bar offers, each dispatching the store event that answers it. */
function barActions(
	bar: DraftBar,
	entry: DraftEntry,
	send: (event: DraftEntryEvent | DraftSendEvent) => void,
	select: () => void,
): BarAction[] {
	switch (bar.kind) {
		case "edited":
			// D15
			return [
				{ label: "Keep mine", run: () => send({ type: "CONFLICT_KEEP_MINE" }) },
				{ label: "Use theirs", run: () => send({ type: "CONFLICT_USE_THEIRS" }) },
			];
		case "discarded":
			// D16
			return [
				{ label: "Restore", run: () => send({ type: "CONFLICT_RESTORE" }) },
				{ label: "Let it go", run: () => send({ type: "CONFLICT_LET_GO" }) },
			];
		case "uncertain":
			// D31: Show conversation is `loadInto`, which D4 runs for a stored thread.
			return [
				...(entry.thread === "listed" || entry.thread === "unlisted"
					? [{ label: "Show conversation", run: select }]
					: []),
				{ label: "Dismiss", run: () => send({ type: "UNCERTAIN_DISMISS" }) },
			];
		case "copy-came-back":
			// D9c
			return [
				{ label: "Discard the copy", run: () => send({ type: "COPY_DISCARD" }) },
				{ label: "Keep it", run: () => send({ type: "COPY_KEEP" }) },
			];
		case "credential":
			// D36: the second answer only records the user's choice; the hold stays.
			return [
				{ label: "Save to my account", run: () => send({ type: "CREDENTIAL_ACK" }) },
				{ label: "Keep in this tab only", run: () => keepInTab(keyId(entry.key)) },
			];
		case "sending":
		case "claimed":
			return [];
	}
}

/** A bar that asks the user to decide: announced as an alert, its actions just above the box. */
function DecisionBar({
	text,
	actions,
	children,
	onDone,
}: {
	text: string;
	actions: BarAction[];
	children?: ReactNode;
	onDone: () => void;
}) {
	const id = useId();
	return (
		<div
			role="alert"
			aria-labelledby={id}
			data-testid="elench-draft-bar"
			className="border border-border bg-card px-3 py-2"
		>
			<p id={id} className="text-ui-sm text-foreground">
				{text}
			</p>
			{children}
			<div className="mt-2 flex flex-wrap items-center gap-1.5">
				{actions.map((a) => (
					<Button
						key={a.label}
						type="button"
						size="xs"
						variant="outline"
						onClick={() => {
							a.run();
							onDone();
						}}
					>
						{a.label}
					</Button>
				))}
			</div>
		</div>
	);
}

/** D15's two texts, quoted, so the choice is made seeing both. */
function ConflictTexts({ mine, theirs }: { mine: string; theirs: string }) {
	return (
		<dl className="mt-1.5 grid gap-0.5 text-ui-xs text-muted-foreground">
			<div className="flex min-w-0 gap-1.5">
				<dt className="shrink-0">Yours:</dt>
				<dd className="min-w-0 truncate text-foreground">{mine === "" ? "(empty)" : `“${mine}”`}</dd>
			</div>
			<div className="flex min-w-0 gap-1.5">
				<dt className="shrink-0">Theirs:</dt>
				<dd className="min-w-0 truncate text-foreground">{theirs === "" ? "(empty)" : `“${theirs}”`}</dd>
			</div>
		</dl>
	);
}

/**
 * The bar above the composer: the bar of what holds the box or needs a decision, then the lines the
 * store raised since this draft's last send. Renders an empty live region when there is nothing.
 */
export function DraftBarSlot({ draftKey }: DraftSlotProps) {
	const draft = useElenchDraft();
	const store = draft?.store ?? null;
	const view = useDraftsView(store);
	const id = keyId(draftKey);
	const kept = useKeptInTab(id);
	const ref = useRef<HTMLDivElement>(null);
	const entry = view?.drafts.entries[id] ?? null;
	const heldForCredential = entry?.save === "held" && entry.blockedBy?.kind === "credential";

	// D36: once the hold lifts (acknowledged, or the match edited away), a new match asks again.
	useEffect(() => {
		if (!heldForCredential) forgetKeptInTab(id);
	}, [heldForCredential, id]);

	const send = useCallback(
		(event: DraftEntryEvent | DraftSendEvent) => store?.dispatch({ type: "ENTRY", key: draftKey, event }),
		[store, draftKey],
	);
	const select = useCallback(() => {
		if (entry !== null) store?.dispatch({ type: "SELECT", key: draftKey, thread: entry.thread });
	}, [store, draftKey, entry]);

	const bar = entry === null ? null : barOf(entry, kept);
	// While the box is frozen for a send, its state is the whole story: the lines of earlier sends
	// were acknowledged by this send, and a line of its own would only repeat the bar.
	const lines = view === null || bar?.kind === "sending" ? [] : noticeLines(view, draftKey);
	const empty = bar === null && lines.length === 0;

	let shownBar: ReactNode = null;
	if (bar !== null && entry !== null) {
		const actions = barActions(bar, entry, send, select);
		shownBar =
			actions.length === 0 ? (
				<p className="text-ui-sm text-muted-foreground">{barText(bar)}</p>
			) : (
				<DecisionBar text={barText(bar)} actions={actions} onDone={() => focusBox(ref.current)}>
					{bar.kind === "edited" && <ConflictTexts mine={bar.mine} theirs={bar.theirs} />}
				</DecisionBar>
			);
	}

	return (
		<div ref={ref} role="status" aria-live="polite">
			{!empty && (
				<div data-testid="elench-draft-status" className="flex flex-col gap-1 px-1 pb-2">
					{shownBar}
					{lines.map((line) => (
						<p key={line} className="text-ui-sm text-muted-foreground">
							{line}
						</p>
					))}
				</div>
			)}
		</div>
	);
}

// ── The footer ──────────────────────────────────────────────────────────────────────────────

/** D24's other-org hold, naming the org this tab's words wait for. */
function HeldOtherOrg({ orgId }: { orgId: string }) {
	const name = useWorkspaceStore((s) => s.organizations.find((o) => o.id === orgId)?.name ?? null);
	return <>{heldOtherOrgText(name)}</>;
}

/**
 * True for `SAVED_SHOWN_MS` after the host recorded the key acknowledged after a save, while the box
 * still shows exactly what the server holds.
 */
function useJustSaved(id: string, entry: DraftEntry | null): boolean {
	const at = useSavedAt(id);
	const acknowledged = entry !== null && isAcknowledged(entry);
	const [, rerender] = useState(0);
	const left = at === null ? 0 : at + SAVED_SHOWN_MS - Date.now();
	useEffect(() => {
		if (left <= 0) return;
		const t = setTimeout(() => rerender((n) => n + 1), left);
		return () => clearTimeout(t);
	}, [left]);
	return acknowledged && left > 0;
}

/** The composer footer's status line (§7.4): one status per key, true to what the server holds. */
export function DraftFooterSlot({ draftKey }: DraftSlotProps) {
	const draft = useElenchDraft();
	const view = useDraftsView(draft?.store ?? null);
	const id = keyId(draftKey);
	const kept = useKeptInTab(id);
	const pathname = usePathname() ?? "/";
	const entry = view?.drafts.entries[id] ?? null;
	const justSaved = useJustSaved(id, entry);
	const footer =
		entry === null
			? null
			: footerOf(entry, { uncached: view?.uncached[id] === true, keptInTab: kept, orgName: null, pathname });

	let body: ReactNode = null;
	if (footer !== null && entry !== null) {
		const otherOrg = entry.save === "held" && entry.blockedBy?.kind === "other-org";
		body = (
			<>
				<StatusBadge status={footer.tier} tier={footer.tier} showLabel={false} aria-hidden />
				<span>
					{otherOrg ? <HeldOtherOrg orgId={entry.key.orgId} /> : footer.text}
					{footer.address !== undefined && (
						<>
							{" "}
							<Link href={footer.address} className="text-foreground underline underline-offset-2">
								Open the new address
							</Link>
						</>
					)}
				</span>
			</>
		);
	} else if (justSaved) {
		body = (
			<>
				<StatusBadge status="active" tier="active" showLabel={false} aria-hidden />
				<span>{COPY.saved}</span>
			</>
		);
	}

	return (
		<div role="status" aria-live="polite">
			{body !== null && (
				<p data-testid="elench-draft-footer" className="flex items-start gap-1.5 px-1 pt-1.5 text-ui-xs text-muted-foreground">
					{body}
				</p>
			)}
		</div>
	);
}
