"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ChevronLeft, LayoutGrid, Minimize2, PanelLeft } from "lucide-react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlethiaMark } from "@repo/brand/lockup";
import { ArtifactPanel } from "@/components/agent/artifact-panel";
import { WidgetGrid } from "@/components/agent/widgets/widget-grid";
import { ThreadRail } from "@/components/agent/thread-rail";
import type { AgentThread } from "@/lib/db/schema";
import { useArtifactStore } from "@/lib/stores/use-artifact-store";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { Dialog, DialogContent, DialogTitle } from "@repo/ui/dialog";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@repo/ui/sheet";
import { cn } from "@repo/ui/utils";
import { ElenchScopeChip } from "./elench-scope-chip";
import { useConversationDraftFacts, useUnsentConversations } from "./use-elench-threads";

/**
 * Split-pane bounds as RATIOS of the split width (the panes sit ~50/50, so a fixed pixel
 * threshold was far too small on a wide modal). Drag the right pane below a quarter of the
 * split and it snaps closed; otherwise it's clamped to [25%, 75%] — so the pane is either
 * collapsed or at least a quarter wide, with no dead band in between.
 */
const SNAP_RATIO = 0.25;
const MAX_RATIO = 0.75;
/** Initial width on first open (px), clamped into the ratio range. */
const DEFAULT_WIDTH = 440;

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

/** Tailwind v4's `lg` (64rem); the console overrides no breakpoint. */
const LG_QUERY = "(min-width: 64rem)";

/**
 * Calls `onReachLg` when the viewport widens to `lg` while `active` is true. The narrow sheet is
 * `lg:hidden`, but hiding a popup does not close it: base-ui keeps the dialog open (focus trapped
 * in a `display:none` popup, and an invisible internal backdrop that swallows the next click). So
 * crossing to `lg` CLOSES the sheet rather than merely hiding it. A missing `matchMedia` (an old
 * engine, jsdom) leaves the sheet as it is.
 */
function useCloseAtLg(active: boolean, onReachLg: () => void): void {
	useEffect(() => {
		if (!active || typeof window.matchMedia !== "function") return;
		const mq = window.matchMedia(LG_QUERY);
		/** Closes on the transition INTO `lg`; narrowing again is not an event to act on. */
		const onChange = (e: { matches: boolean }) => {
			if (e.matches) onReachLg();
		};
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, [active, onReachLg]);
}

/**
 * The thread rail's toggle BELOW `lg` (#5650). The docked rail column is `hidden … lg:flex`, so
 * under 1024px the store's `railOpen` changes nothing on screen; this button opens the rail as a
 * sheet instead. It is `lg:hidden` and rendered regardless of `railOpen`, because below `lg` it is
 * the only way to reach Delete chat, Artifacts and Knowledge. At `lg` and up it is not displayed,
 * and the `railOpen`-driven toggle keeps the job it always had.
 *
 * It carries the Unsent count when that is not zero (ADR 0001 decision 3): below `lg` the rail is
 * behind this toggle, and a phone user must see that words are unsent without opening the sheet.
 * The count is in its accessible name too, so a screen reader hears what a sighted user sees.
 */
function NarrowRailToggle({
	open,
	onOpen,
	unsent,
	className,
}: {
	/** Whether the sheet this toggle opens is open — announced as `aria-expanded`. */
	open: boolean;
	onOpen: () => void;
	/** How many conversations the rail's Unsent group holds. */
	unsent: number;
	className: string;
}) {
	return (
		<button
			type="button"
			aria-label={unsent > 0 ? `Open sidebar, ${unsent} unsent` : "Open sidebar"}
			aria-haspopup="dialog"
			aria-expanded={open}
			data-testid="elench-narrow-rail-toggle"
			onClick={onOpen}
			// Positioned, so the count can sit on its corner; an absolutely placed caller keeps its own.
			className={cn("relative", className)}
		>
			<PanelLeft className="h-4 w-4" />
			{unsent > 0 && (
				<span
					data-testid="elench-narrow-rail-unsent"
					className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center bg-foreground px-1 font-mono text-ui-3xs text-background"
				>
					{unsent}
				</span>
			)}
		</button>
	);
}

/**
 * The Elench modal chrome — a near-fullscreen dialog (Radix Dialog: focus-trap / ESC /
 * scroll-lock). Layout mirrors the Elench design, in our grayscale system:
 *  - a collapsible thread rail (org context),
 *  - the active conversation's top bar (centered title, split-view + minimize),
 *  - the chat body (a 720px transcript column + floating composer), and
 *  - an on-demand generative-UI split pane (the artifact panel) with a drag-resize handle.
 * The empty landing owns its own hero, so it shows only the floating minimize / rail toggle.
 * ESC or the overlay closes the surface; minimize docks it as a panel.
 */
export function ElenchModal({
	isOrg,
	threads,
	activeId,
	isEmpty,
	title,
	onSelectThread,
	onNewChat,
	onDeleteThread,
	gallery,
	knowledge,
	children,
}: {
	isOrg: boolean;
	threads: AgentThread[];
	activeId: string | null;
	/** True while the conversation has no messages (the hero landing owns its chrome). */
	isEmpty: boolean;
	/** Centered title in the active-conversation top bar. */
	title: string;
	onSelectThread: (id: string) => void;
	onNewChat: () => void;
	onDeleteThread: (id: string) => void;
	/** The Artifacts library — replaces the chat in the main region when mainView=artifacts. */
	gallery?: ReactNode;
	/** The Knowledge panel — replaces the chat when mainView=knowledge. */
	knowledge?: ReactNode;
	children: ReactNode;
}) {
	const minimize = useElenchStore((s) => s.minimize);
	const close = useElenchStore((s) => s.close);
	// Rail state lives in the store so it survives a minimize→maximize round-trip.
	const sidebarOpen = useElenchStore((s) => s.railOpen);
	const setSidebarOpen = useElenchStore((s) => s.setRailOpen);
	// Which surface the main region shows (chat / artifacts / knowledge) — mutually exclusive.
	const mainView = useElenchStore((s) => s.mainView);
	const setMainView = useElenchStore((s) => s.setMainView);
	const showSidebar = sidebarOpen;
	// Below `lg` the rail opens as a sheet. Local, not the store's `railOpen`: that flag is the
	// docked column's, persists across minimize, and must not open an overlay when the window
	// later widens; a sheet is a transient thing the user opened just now.
	const [narrowRailOpen, setNarrowRailOpen] = useState(false);
	const closeNarrowRail = useCallback(() => setNarrowRailOpen(false), []);
	// The rail's Unsent group, and the delete confirm's draft count (ADR 0001 §6.3, §7.4).
	const unsent = useUnsentConversations(threads);
	const countDrafts = useConversationDraftFacts();
	useCloseAtLg(narrowRailOpen, closeNarrowRail);

	// The generative-UI split pane is LAYERED: the per-chat widget grid is the base
	// view (gridOpen) and the project/job inspector (artifact) overlays it on demand.
	const artifact = useArtifactStore((s) => s.artifact);
	const gridOpen = useArtifactStore((s) => s.gridOpen);
	const closeArtifact = useArtifactStore((s) => s.close);
	const openGrid = useArtifactStore((s) => s.openGrid);
	const closeGrid = useArtifactStore((s) => s.closeGrid);
	const splitOpen = !!artifact || gridOpen;

	// Drag-resize the right pane from its left edge. Thresholds are RATIOS of the split row's
	// own width (measured off `splitRef`), so they scale with the modal: below 25% it snaps
	// closed (width 0, collapsed); the edge chevron — or dragging the handle back left —
	// reopens it. Width persists across a collapse.
	const splitRef = useRef<HTMLDivElement>(null);
	const [splitW, setSplitW] = useState(DEFAULT_WIDTH);
	const [collapsed, setCollapsed] = useState(false);
	// Suppresses the width transition mid-drag so the pane tracks the cursor 1:1.
	const [isDragging, setIsDragging] = useState(false);
	const dragging = useRef(false);
	// A freshly-opened split should never start collapsed.
	useEffect(() => {
		if (splitOpen) setCollapsed(false);
	}, [splitOpen]);
	const onHandleDown = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
		dragging.current = true;
		setIsDragging(true);
		e.currentTarget.setPointerCapture(e.pointerId);
	}, []);
	const onHandleMove = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
		if (!dragging.current) return;
		const el = splitRef.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		const w = r.right - e.clientX;
		const snap = r.width * SNAP_RATIO;
		if (w < snap) {
			setCollapsed(true);
		} else {
			setCollapsed(false);
			// Min width IS the snap threshold — the pane never rests below a quarter.
			setSplitW(clamp(w, snap, r.width * MAX_RATIO));
		}
	}, []);
	const onHandleUp = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
		dragging.current = false;
		setIsDragging(false);
		e.currentTarget.releasePointerCapture(e.pointerId);
	}, []);

	return (
		<Dialog open onOpenChange={(o) => !o && close()}>
			<DialogContent
				size="fullscreen"
				showCloseButton={false}
				data-testid="elench-modal"
			>
				<DialogTitle className="sr-only">Elench</DialogTitle>

				{showSidebar && (
					<div className="hidden w-[284px] flex-none flex-col border-r border-border bg-card lg:flex">
						<div className="flex items-center gap-2 px-3.5 py-3">
							<AlethiaMark className="h-6 w-auto flex-none text-foreground" />
							<span className="min-w-0 flex-1 truncate text-sm font-semibold">
								Elench
							</span>
							<button
								type="button"
								aria-label="Collapse sidebar"
								onClick={() => setSidebarOpen(false)}
								className="ml-auto flex size-7 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							>
								<PanelLeft className="h-4 w-4" />
							</button>
						</div>
						<ThreadRail
							threads={threads}
							activeId={activeId}
							onSelect={onSelectThread}
							onNew={onNewChat}
							onDelete={onDeleteThread}
							unsent={unsent}
							countDrafts={countDrafts}
							onOpenArtifacts={
								gallery ? () => setMainView("artifacts") : undefined
							}
							artifactsActive={mainView === "artifacts"}
							onOpenKnowledge={
								knowledge ? () => setMainView("knowledge") : undefined
							}
							knowledgeActive={mainView === "knowledge"}
						/>
					</div>
				)}

				{/* The same rail below `lg`, as a left sheet over the modal (#5650). Navigating —
				    a chat, New chat, Artifacts, Knowledge — closes it, because the destination is
				    what the user wanted to see and the sheet covers most of a phone. Deleting does
				    NOT: the row disappears in place, and the user may be clearing several.
				    NO SCRIM: the sheet mounts inside the modal, so base-ui treats it as a nested
				    dialog and its backdrop renders only with `forceRender`, which `SheetContent`
				    does not pass. The modal behind it is therefore not dimmed — a recorded choice
				    of this unit, since a scrim needs an @repo/ui change. */}
				<Sheet open={narrowRailOpen} onOpenChange={setNarrowRailOpen}>
					<SheetContent
						side="left"
						showCloseButton={false}
						data-testid="elench-narrow-rail"
						className="z-[var(--z-overlay-nested)] w-[284px] gap-0 bg-card p-0 lg:hidden"
					>
						<div className="flex items-center gap-2 px-3.5 py-3">
							<AlethiaMark className="h-6 w-auto flex-none text-foreground" />
							<SheetTitle className="min-w-0 flex-1 truncate text-sm font-semibold">
								Chats
							</SheetTitle>
							<SheetClose
								aria-label="Close sidebar"
								className="ml-auto flex size-7 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							>
								<PanelLeft className="h-4 w-4" />
							</SheetClose>
						</div>
						<ThreadRail
							className="flex min-h-0 w-full flex-1 border-r-0"
							threads={threads}
							activeId={activeId}
							onSelect={(id) => {
								onSelectThread(id);
								setNarrowRailOpen(false);
							}}
							onNew={() => {
								onNewChat();
								setNarrowRailOpen(false);
							}}
							onDelete={onDeleteThread}
							unsent={unsent}
							countDrafts={countDrafts}
							onOpenArtifacts={
								gallery
									? () => {
											setMainView("artifacts");
											setNarrowRailOpen(false);
										}
									: undefined
							}
							artifactsActive={mainView === "artifacts"}
							onOpenKnowledge={
								knowledge
									? () => {
											setMainView("knowledge");
											setNarrowRailOpen(false);
										}
									: undefined
							}
							knowledgeActive={mainView === "knowledge"}
						/>
					</SheetContent>
				</Sheet>

				<main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
					{(gallery && mainView === "artifacts") ||
					(knowledge && mainView === "knowledge") ? (
						<>
							{/* Artifacts and Knowledge carry their own top bar and no way back to the
							    chats; at `lg` the rail beside them is that way. Below it, this strip
							    is — without it the sheet that opened them could not be reopened. */}
							<div className="flex flex-none items-center border-b border-border px-3 py-1.5 lg:hidden">
								<NarrowRailToggle
									open={narrowRailOpen}
									onOpen={() => setNarrowRailOpen(true)}
									unsent={unsent.length}
									className="flex size-8 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
								/>
							</div>
							{mainView === "artifacts" ? gallery : knowledge}
						</>
					) : (
						<>
							{isEmpty ? (
								<>
									{!sidebarOpen && (
								<button
									type="button"
									aria-label="Open sidebar"
									onClick={() => setSidebarOpen(true)}
									className="absolute left-4 top-4 z-[var(--z-raised)] hidden size-8 items-center justify-center rounded-none border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground lg:flex"
								>
									<PanelLeft className="h-4 w-4" />
								</button>
							)}
							<NarrowRailToggle
								open={narrowRailOpen}
									onOpen={() => setNarrowRailOpen(true)}
									unsent={unsent.length}
								className="absolute left-4 top-4 z-[var(--z-raised)] flex size-8 items-center justify-center rounded-none border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground lg:hidden"
							/>
							{/* The empty state hides the top-bar grid toggle — so if the split
							    pane is somehow open here, surface a close control so it can never
							    get stranded with no way out. */}
							{splitOpen && (
								<button
									type="button"
									aria-label="Close split view"
									onClick={() => {
										closeArtifact();
										closeGrid();
									}}
									className="absolute right-14 top-4 z-[var(--z-raised)] flex size-8 items-center justify-center rounded-none border border-border bg-background text-foreground shadow-sm transition-colors hover:bg-muted"
								>
									<LayoutGrid className="h-4 w-4" />
								</button>
							)}
							<button
								type="button"
								aria-label="Minimize to panel"
								onClick={minimize}
								className="absolute right-4 top-4 z-[var(--z-raised)] flex size-8 items-center justify-center rounded-none border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
							>
								<Minimize2 className="h-4 w-4" />
							</button>
						</>
					) : (
						/* Active-conversation top bar: centered title, split-view + minimize. */
						<div className="flex flex-none items-center gap-2 border-b border-border px-3 py-2.5">
							<div className="flex min-w-0 flex-1 items-center gap-1">
								{!sidebarOpen && (
									<button
										type="button"
										aria-label="Open sidebar"
										onClick={() => setSidebarOpen(true)}
										className="hidden size-8 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:flex"
									>
										<PanelLeft className="h-4 w-4" />
									</button>
								)}
								<NarrowRailToggle
									open={narrowRailOpen}
									onOpen={() => setNarrowRailOpen(true)}
									unsent={unsent.length}
									className="flex size-8 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
								/>
								{/* Which project + environment this conversation plans against — the modal
								    hides the topbar switcher, so without it the scope is unreadable. */}
								<ElenchScopeChip className="px-1" />
							</div>
							<div className="truncate text-sm font-medium text-foreground">
								{title}
							</div>
							<div className="flex flex-1 items-center justify-end gap-1">
								<button
									type="button"
									aria-label={splitOpen ? "Close split view" : "Open widget grid"}
									onClick={() => {
										if (splitOpen) {
											closeArtifact();
											closeGrid();
										} else {
											openGrid();
										}
									}}
									className={
										"flex size-8 items-center justify-center rounded-none transition-colors hover:bg-muted hover:text-foreground " +
										(splitOpen ? "text-foreground" : "text-muted-foreground")
									}
								>
									<LayoutGrid className="h-4 w-4" />
								</button>
								<button
									type="button"
									aria-label="Minimize to panel"
									onClick={minimize}
									className="flex size-8 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
								>
									<Minimize2 className="h-4 w-4" />
								</button>
							</div>
						</div>
					)}

					<div ref={splitRef} className="flex min-h-0 flex-1">
						<div className="flex min-w-0 flex-1 flex-col">{children}</div>
						{splitOpen && (
							<>
								{/* Cloudflare-style divider: a hairline 1px seam with a centered rounded
								    grab-pill. Dragging resizes; below 25% of the split it snaps closed. */}
								<button
									type="button"
									aria-label="Resize or collapse panel"
									onPointerDown={onHandleDown}
									onPointerMove={onHandleMove}
									onPointerUp={onHandleUp}
									className="group/split relative z-[var(--z-raised)] -mx-1 flex w-3 flex-none cursor-col-resize items-center justify-center"
								>
									<span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
									<span className="pointer-events-none h-12 w-1 rounded-full bg-muted-foreground/25 transition-colors group-hover/split:bg-muted-foreground/60" />
								</button>
								<div
									style={{ width: collapsed ? 0 : splitW }}
									className={
										"flex-none overflow-hidden" +
										(isDragging ? "" : " transition-[width] duration-150 ease-out")
									}
								>
									{artifact ? <ArtifactPanel /> : <WidgetGrid />}
								</div>
								{collapsed && (
									// z-20 is the ONE layer here that the named scale cannot express: its job is
									// "one step above the --z-raised drag handle it overlaps", and the scale has
									// no rung between --z-raised (10) and --z-header/--z-overlay (50). Naming it
									// --z-overlay would move it 40 rungs — a re-layering, which tokens.css says
									// is a separate, visual change. Left as a literal, deliberately.
									<button
										type="button"
										aria-label="Expand panel"
										onClick={() => setCollapsed(false)}
										className="absolute right-0 top-1/2 z-20 flex size-7 -translate-y-1/2 items-center justify-center rounded-l-none border border-r-0 border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
									>
										<ChevronLeft className="h-4 w-4" />
									</button>
								)}
							</>
						)}
							</div>
						</>
					)}
				</main>
			</DialogContent>
		</Dialog>
	);
}
