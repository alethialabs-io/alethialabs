"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";

/**
 * Loading placeholder for the chat transcript, shown while the thread list resolves
 * and the persisted transcript loads (distinct from the empty landing, which is a
 * settled "no messages yet" state). A couple of alternating user/assistant message
 * rows so the resume window reads as loading, not blank.
 */
export function ChatSkeleton({ className }: { className?: string }) {
	return (
		<div
			className={cn("flex min-h-0 flex-1 flex-col gap-8 p-4", className)}
			aria-hidden
		>
			{/* user bubble (right-aligned, short) */}
			<div className="flex justify-end">
				<Skeleton className="h-8 w-40 rounded-none" />
			</div>
			{/* assistant response (left-aligned, multi-line) */}
			<div className="flex flex-col gap-2">
				<Skeleton className="h-4 w-3/4 rounded-none" />
				<Skeleton className="h-4 w-5/6 rounded-none" />
				<Skeleton className="h-4 w-2/3 rounded-none" />
			</div>
			<div className="flex justify-end">
				<Skeleton className="h-8 w-28 rounded-none" />
			</div>
			<div className="flex flex-col gap-2">
				<Skeleton className="h-4 w-4/5 rounded-none" />
				<Skeleton className="h-4 w-1/2 rounded-none" />
			</div>
		</div>
	);
}
