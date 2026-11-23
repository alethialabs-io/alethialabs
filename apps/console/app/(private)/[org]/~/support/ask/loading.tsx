// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import { SHELL_VIEWPORT } from "@/components/shell/shell-metrics";

/**
 * The page's frame, as `page.tsx` draws it: the full-height column that bleeds to the shell's edge
 * (the negative margins undo the shell's padding, breakpoint for breakpoint).
 */
const ASK_FRAME = `flex ${SHELL_VIEWPORT} -m-4 flex-col sm:-m-6 lg:-m-8 xl:-m-10`;

/**
 * The starter prompts' widths, one per suggestion chip the page opens on. The chips are `size="sm"`
 * outline buttons (32px), and their text is the support chat's own, which this file cannot import
 * (it is private to `support-ask-chat.tsx`) — so the widths stand in for it.
 */
const SUGGESTION_WIDTHS = ["w-64", "w-72", "w-40"] as const;

/**
 * The Ask-AI route's loading state, in the shape the page opens on (G-18). A new conversation has no
 * messages: it opens on the "Try one of these:" line and a row of suggestion chips at the top of the
 * conversation area (`AgentChat`'s empty state, padded `p-4`), and the composer docked at the bottom
 * under a rule (`border-t p-3`): the prompt box at its `min-h-16` floor over its footer row with the
 * send button. The old skeleton drew three chat bubbles, which is the shape of a conversation the
 * page never opens on. Synchronous, on `SkeletonRoot`, with no width of its own (RUBRIC, "The
 * skeleton rules").
 */
export default function SupportAskLoading() {
	return (
		<SkeletonRoot className={ASK_FRAME}>
			<div className="min-h-0 flex-1 p-4">
				<div className="space-y-3">
					<p className="text-sm text-muted-foreground">Try one of these:</p>
					<div className="flex flex-nowrap items-center gap-2 overflow-hidden py-1">
						{SUGGESTION_WIDTHS.map((w) => (
							<Skeleton key={w} className={`h-8 ${w} shrink-0 rounded-none`} />
						))}
					</div>
				</div>
			</div>
			<div className="border-t border-border p-3">
				<div className="border border-border">
					<Skeleton className="h-16 w-full rounded-none" />
					<div className="flex justify-end p-1">
						<Skeleton className="size-8 rounded-none" />
					</div>
				</div>
			</div>
		</SkeletonRoot>
	);
}
