"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ChevronLeft, LayoutGrid, Minimize2, PanelLeft } from "lucide-react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlethiaLogo } from "@repo/brand/alethia-logo";
import { ArtifactPanel } from "@/components/agent/artifact-panel";
import { WidgetGrid } from "@/components/agent/widgets/widget-grid";
import { ThreadRail } from "@/components/agent/thread-rail";
import type { AgentThread } from "@/lib/db/schema";
import { useArtifactStore } from "@/lib/stores/use-artifact-store";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { Dialog, DialogContent, DialogTitle } from "@repo/ui/dialog";

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
	/** The Artifacts gallery (org only) — shown in the main region when `galleryOpen`. */
	gallery?: ReactNode;
	children: ReactNode;
}) {
	const minimize = useElenchStore((s) => s.minimize);
	const close = useElenchStore((s) => s.close);
	// Rail state lives in the store so it survives a minimize→maximize round-trip.
	const sidebarOpen = useElenchStore((s) => s.railOpen);
	const setSidebarOpen = useElenchStore((s) => s.setRailOpen);
	// The Artifacts gallery replaces the chat in the main region (org only).
	const galleryOpen = useElenchStore((s) => s.galleryOpen);
	const setGalleryOpen = useElenchStore((s) => s.setGalleryOpen);
	// Both contexts persist threads now, so the rail shows for project as well as org.
	const showSidebar = sidebarOpen;

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
							<AlethiaLogo className="h-6 w-auto text-foreground" />
							<span className="text-sm font-semibold">Chat</span>
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
							onOpenArtifacts={
								gallery ? () => setGalleryOpen(true) : undefined
							}
							artifactsActive={galleryOpen}
						/>
					</div>
				)}

				<main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
					{gallery && galleryOpen ? (
						gallery
					) : (
						<>
							{isEmpty ? (
								<>
									{!sidebarOpen && (
								<button
									type="button"
									aria-label="Open sidebar"
									onClick={() => setSidebarOpen(true)}
									className="absolute left-4 top-4 z-10 flex size-8 items-center justify-center rounded-none border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
								>
									<PanelLeft className="h-4 w-4" />
								</button>
							)}
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
									className="absolute right-14 top-4 z-10 flex size-8 items-center justify-center rounded-none border border-border bg-background text-foreground shadow-sm transition-colors hover:bg-muted"
								>
									<LayoutGrid className="h-4 w-4" />
								</button>
							)}
							<button
								type="button"
								aria-label="Minimize to panel"
								onClick={minimize}
								className="absolute right-4 top-4 z-10 flex size-8 items-center justify-center rounded-none border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
							>
								<Minimize2 className="h-4 w-4" />
							</button>
						</>
					) : (
						/* Active-conversation top bar: centered title, split-view + minimize. */
						<div className="flex flex-none items-center gap-2 border-b border-border px-3 py-2.5">
							<div className="flex flex-1 items-center gap-1">
								{!sidebarOpen && (
									<button
										type="button"
										aria-label="Open sidebar"
										onClick={() => setSidebarOpen(true)}
										className="flex size-8 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
									>
										<PanelLeft className="h-4 w-4" />
									</button>
								)}
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
									className="group/split relative z-10 -mx-1 flex w-3 flex-none cursor-col-resize items-center justify-center"
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
