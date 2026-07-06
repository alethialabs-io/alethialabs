"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Minimize2, PanelLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { AlethiaLogo } from "@repo/brand/alethia-logo";
import { ArtifactPanel } from "@/components/agent/artifact-panel";
import { ThreadRail } from "@/components/agent/thread-rail";
import type { AgentThread } from "@/lib/db/schema";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import {
	Dialog,
	DialogContent,
	DialogTitle,
} from "@repo/ui/dialog";

/**
 * The Elench modal chrome — a near-fullscreen dialog: a collapsible thread sidebar
 * (org context), the chat body (minimize button floats top-right), and the artifact
 * panel (org). Radix Dialog gives focus-trap / ESC / scroll-lock; ESC or the overlay
 * closes the surface, the minimize button docks it as a panel.
 */
export function ElenchModal({
	isOrg,
	threads,
	activeId,
	onSelectThread,
	onNewChat,
	onDeleteThread,
	children,
}: {
	isOrg: boolean;
	threads: AgentThread[];
	activeId: string | null;
	onSelectThread: (id: string) => void;
	onNewChat: () => void;
	onDeleteThread: (id: string) => void;
	children: ReactNode;
}) {
	const minimize = useElenchStore((s) => s.minimize);
	const close = useElenchStore((s) => s.close);
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const showSidebar = isOrg && sidebarOpen;

	return (
		<Dialog open onOpenChange={(o) => !o && close()}>
			<DialogContent
				showCloseButton={false}
				className="left-[7px] top-[7px] flex h-[calc(100dvh-14px)] w-[calc(100vw-14px)] max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-lg border border-border bg-background p-0"
			>
				<DialogTitle className="sr-only">Elench</DialogTitle>

				{showSidebar && (
					<div className="hidden w-[246px] flex-none flex-col border-r border-border bg-card lg:flex">
						<div className="flex items-center gap-2 px-3.5 py-3">
							<AlethiaLogo className="h-4 w-auto text-foreground" />
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
						/>
					</div>
				)}

				<main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
					{isOrg && !sidebarOpen && (
						<button
							type="button"
							aria-label="Open sidebar"
							onClick={() => setSidebarOpen(true)}
							className="absolute left-4 top-4 z-10 flex size-8 items-center justify-center rounded-none border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
						>
							<PanelLeft className="h-4 w-4" />
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

					<div className="flex min-h-0 flex-1 flex-col">{children}</div>
				</main>

				{isOrg && <ArtifactPanel />}
			</DialogContent>
		</Dialog>
	);
}
