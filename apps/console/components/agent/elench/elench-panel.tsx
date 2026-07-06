"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Maximize2, Plus, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { AgentThread } from "@/lib/db/schema";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { ElenchConversationSwitcher } from "./elench-conversation-switcher";

/** The faint grayscale dot-grid the panel content sits on. */
const DOT_GRID: CSSProperties = {
	backgroundImage:
		"radial-gradient(circle, color-mix(in oklab, var(--foreground) 7%, transparent) 1px, transparent 1.4px)",
	backgroundSize: "15px 15px",
};

/**
 * The Elench panel chrome — a docked drawer floating over the right of the workspace
 * (no backdrop / no scroll-lock, so the page stays interactive). Header: conversation
 * switcher + new-chat + maximize (→ modal) + close. The chat body (with its docked
 * composer) renders on a faint dot-grid.
 */
export function ElenchPanel({
	isOrg,
	threads,
	activeId,
	onSelectThread,
	onNewChat,
	children,
}: {
	isOrg: boolean;
	threads: AgentThread[];
	activeId: string | null;
	onSelectThread: (id: string) => void;
	onNewChat: () => void;
	children: ReactNode;
}) {
	const maximize = useElenchStore((s) => s.maximize);
	const close = useElenchStore((s) => s.close);

	return (
		<div
			role="dialog"
			aria-label="Elench assistant"
			className="fixed right-0 top-0 z-40 flex h-dvh w-[458px] max-w-full flex-col border-l border-border bg-background shadow-[-8px_0_30px_rgba(0,0,0,0.12)] duration-200 animate-in slide-in-from-right"
		>
			<header className="flex flex-none items-center gap-2 border-b border-border px-3.5 py-2.5">
				<ElenchConversationSwitcher
					isOrg={isOrg}
					threads={threads}
					activeId={activeId}
					onSelectThread={onSelectThread}
					onNewChat={onNewChat}
				/>
				<div className="ml-auto flex items-center gap-0.5 text-muted-foreground">
					<button
						type="button"
						aria-label="New conversation"
						onClick={onNewChat}
						className="flex size-8 items-center justify-center rounded-none transition-colors hover:bg-muted hover:text-foreground"
					>
						<Plus className="h-4 w-4" />
					</button>
					<button
						type="button"
						aria-label="Expand to full screen"
						onClick={maximize}
						className="flex size-8 items-center justify-center rounded-none transition-colors hover:bg-muted hover:text-foreground"
					>
						<Maximize2 className="h-4 w-4" />
					</button>
					<button
						type="button"
						aria-label="Close assistant"
						onClick={close}
						className="flex size-8 items-center justify-center rounded-none transition-colors hover:bg-muted hover:text-foreground"
					>
						<X className="h-4 w-4" />
					</button>
				</div>
			</header>

			<div className="flex min-h-0 flex-1 flex-col" style={DOT_GRID}>
				{children}
			</div>
		</div>
	);
}
