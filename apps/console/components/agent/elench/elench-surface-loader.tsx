"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	Component,
	type ComponentType,
	type ErrorInfo,
	type ReactNode,
	useEffect,
	useState,
} from "react";
import { Button } from "@repo/ui/button";
import { Skeleton } from "@repo/ui/skeleton";
import { SHELL_HEADER } from "@/components/shell/shell-metrics";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import { ASSISTANT } from "@/lib/copy/vocabulary";
import { type ElenchView, useElenchStore } from "@/lib/stores/use-elench-store";

/**
 * Fetch and evaluate the Elench surface and everything under it — the conversation, the chat
 * transcript, the markdown and code-highlighting stack, the tool renderers and their canvas
 * previews.
 */
function loadSurface(): Promise<ComponentType> {
	return import("./elench-surface").then((m) => m.ElenchSurface);
}

/**
 * Start loading the surface before it is opened — called on the launcher's hover and focus, so
 * the first open does not wait for the chunk. Safe to call repeatedly: the module loader caches
 * the import. A failure here is not reported: nothing is on screen yet, and the open that follows
 * asks again and shows its own failure.
 */
export function preloadElenchSurface(): void {
	loadSurface().catch(() => undefined);
}

/**
 * The docked panel's width, in pixels. It is `ELENCH_PANEL_W` (`./elench-panel.tsx`) written a
 * second time, because importing it from that module would put the panel's own imports in front of
 * every page's first hydration, which is what this file exists to prevent.
 * `tests/components/agent/elench-surface-loader.test.tsx` fails if the two differ.
 */
export const ELENCH_PLACEHOLDER_W = 392;

/** What the load of the surface has come to. `null` while there is no answer yet. */
type SurfaceLoad = { Surface: ComponentType } | { failedAttempt: number } | null;

/**
 * Where a placeholder for the surface is drawn, by the view the assistant was opened in. The
 * panel is a flex child of the shell that takes its width from the main column, so its placeholder
 * takes the same width and nothing moves when the surface arrives. The modal is an overlay, so its
 * placeholder is one too and takes no room from the page.
 */
function PlaceholderFrame({
	view,
	children,
}: {
	view: ElenchView;
	children: ReactNode;
}) {
	const label = `${ASSISTANT} assistant`;
	if (view === "modal") {
		return (
			<div className="fixed inset-0 z-[var(--z-overlay)] flex items-center justify-center bg-background/80 p-4">
				<div
					role="dialog"
					aria-label={label}
					data-slot="elench-placeholder"
					data-view="modal"
					className="flex h-[min(32rem,80dvh)] w-full max-w-2xl flex-col border border-border bg-background"
				>
					{children}
				</div>
			</div>
		);
	}
	return (
		<div
			style={{ width: ELENCH_PLACEHOLDER_W }}
			className="h-full max-w-full shrink-0 overflow-hidden"
		>
			<div
				role="dialog"
				aria-label={label}
				data-slot="elench-placeholder"
				data-view="panel"
				style={{ width: ELENCH_PLACEHOLDER_W }}
				className="flex h-full max-w-full flex-col border-l border-border bg-background"
			>
				{children}
			</div>
		</div>
	);
}

/**
 * What stands where the surface will be while its code is on the way: the panel's own shape — a
 * header at the shell's header height, a transcript, a composer — so "Ask AI" answers at once
 * and nothing jumps when the surface replaces it.
 */
function SurfacePending({ view }: { view: ElenchView }) {
	return (
		<PlaceholderFrame view={view}>
			<SkeletonRoot className="flex min-h-0 flex-1 flex-col">
				<div className={`flex ${SHELL_HEADER} flex-none items-center border-b border-border px-3.5`}>
					<Skeleton className="h-5 w-40" />
				</div>
				<div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
					<Skeleton className="h-4 w-3/4" />
					<Skeleton className="h-4 w-1/2" />
					<Skeleton className="h-4 w-2/3" />
				</div>
				<div className="flex-none border-t border-border p-3">
					<Skeleton className="h-16 w-full" />
				</div>
				<span className="sr-only">Loading {ASSISTANT}</span>
			</SkeletonRoot>
		</PlaceholderFrame>
	);
}

/**
 * What stands where the surface would be when it could not be loaded or could not be drawn. It
 * says so, offers to try again and offers to close. The rest of the console stays as it was: a
 * failure here used to reach the app's error boundary and replace every page.
 */
function SurfaceUnavailable({
	view,
	onRetry,
	onClose,
}: {
	view: ElenchView;
	onRetry: () => void;
	onClose: () => void;
}) {
	return (
		<PlaceholderFrame view={view}>
			<div
				role="alert"
				data-state="error"
				className="flex min-h-0 flex-1 flex-col items-start justify-center gap-3 p-6"
			>
				<p className="text-ui-lg font-medium text-foreground">
					{ASSISTANT} could not be loaded
				</p>
				<p className="text-ui-md leading-relaxed text-muted-foreground">
					The rest of the console is not affected. Check your connection, then try again.
				</p>
				<div className="flex flex-wrap gap-2">
					<Button size="sm" onClick={onRetry}>
						Try again
					</Button>
					<Button size="sm" variant="outline" onClick={onClose}>
						Close
					</Button>
				</div>
			</div>
		</PlaceholderFrame>
	);
}

interface BoundaryProps {
	children: ReactNode;
	/** What to draw in place of the children once they have thrown. `reset` draws them again. */
	fallback: (reset: () => void) => ReactNode;
}

interface BoundaryState {
	failed: boolean;
}

/**
 * The surface's own error boundary. A throw while the surface renders stops here, in the surface's
 * place, instead of reaching the route's boundary and replacing the page the person was on.
 */
class SurfaceBoundary extends Component<BoundaryProps, BoundaryState> {
	state: BoundaryState = { failed: false };

	/** React's error-boundary hook: remember that the children threw. */
	static getDerivedStateFromError(): BoundaryState {
		return { failed: true };
	}

	/** Logs the error; the fallback stays user-facing. */
	componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error("[elench] surface render error", error, info.componentStack);
	}

	/** Draws the children again. */
	private reset = (): void => {
		this.setState({ failed: false });
	};

	/** The children, or the fallback once they have thrown. */
	render(): ReactNode {
		return this.state.failed ? this.props.fallback(this.reset) : this.props.children;
	}
}

/**
 * The app shell's mount point for the Elench surface: nothing until the assistant is first opened,
 * then the surface, kept mounted from then on.
 *
 * WHY THE SHELL DOES NOT IMPORT THE SURFACE (#5849). The shell is on every private route, so a
 * static import put the surface's whole graph — about 150 modules, among them streamdown, shiki,
 * @xyflow/react, motion and @ai-sdk/react — in front of the first hydration of EVERY page, while
 * the surface renders nothing until someone opens the assistant. On a cold load in CI, evaluating
 * the shell's modules was one 378–480 ms task, and until it ended React could neither hydrate nor
 * listen for a click: a click on a filter-bar control in that window was lost (release-gate run
 * 37917147461). The store opens closed and is not persisted, so the server never rendered a
 * surface, and loading it on the client changes no server HTML.
 *
 * THE LATCH. The surface used to be mounted from the start and simply render `null` while closed.
 * Its thread hook does nothing while closed (its load effect is gated on `open`, and closing resets
 * it), so mounting it at first open is the same surface; keeping it mounted after that keeps every
 * later open exactly as it was.
 *
 * THE THREE STATES OF THE LOAD. The import is awaited here rather than through `next/dynamic`,
 * because each of its states needs a render of its own and a failed one needs a second attempt:
 * while the code is on the way the assistant's place holds its shape (`SurfacePending`); when the
 * code cannot be fetched — offline, or a deploy replaced the chunk this page was built with — the
 * same place says so with "Try again" and "Close" (`SurfaceUnavailable`), and "Try again" asks
 * the module loader again; and the surface itself renders inside its own boundary, so a throw in
 * it lands in that same place. None of the three reaches the route's error boundary. While the
 * assistant is closed, none of the three draws anything.
 *
 * `load` is the import. The shell passes nothing and gets the real one; a test passes its own, so
 * each state is reached without depending on how a test runner caches a module that failed.
 */
export function ElenchSurfaceLoader({
	load: loadSurfaceModule = loadSurface,
}: {
	load?: () => Promise<ComponentType>;
} = {}) {
	const open = useElenchStore((s) => s.open);
	const view = useElenchStore((s) => s.view);
	const close = useElenchStore((s) => s.close);
	const [wanted, setWanted] = useState(open);
	if (open && !wanted) setWanted(true);
	const [load, setLoad] = useState<SurfaceLoad>(null);
	// Each "Try again" is a new attempt. A failure is recorded against the attempt that failed, so
	// the placeholder shows again while the next attempt is on the way.
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		if (!wanted) return;
		let current = true;
		loadSurfaceModule().then(
			(Surface) => {
				if (current) setLoad({ Surface });
			},
			() => {
				if (current) setLoad({ failedAttempt: attempt });
			},
		);
		return () => {
			current = false;
		};
	}, [wanted, attempt, loadSurfaceModule]);

	if (!wanted) return null;

	if (load !== null && "Surface" in load) {
		const { Surface } = load;
		return (
			<SurfaceBoundary
				fallback={(reset) =>
					open ? <SurfaceUnavailable view={view} onRetry={reset} onClose={close} /> : null
				}
			>
				<Surface />
			</SurfaceBoundary>
		);
	}
	if (!open) return null;
	if (load !== null && load.failedAttempt === attempt) {
		return (
			<SurfaceUnavailable
				view={view}
				onRetry={() => setAttempt((n) => n + 1)}
				onClose={close}
			/>
		);
	}
	return <SurfacePending view={view} />;
}
