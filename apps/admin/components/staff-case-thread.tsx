"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Avatar, AvatarFallback } from "@repo/ui/avatar";
import { cn } from "@repo/ui/utils";
import { format } from "date-fns";
import { EyeOff } from "lucide-react";
import type { SupportAuthorType } from "@repo/support/enums";
import type { StaffCaseDetail } from "@/lib/queries";

/** The full staff thread message shape (includes the internal-note flag). */
type StaffMessage = StaffCaseDetail["messages"][number];

/** The display name shown above each message, keyed by who authored it. */
const ROLE_LABEL: Record<SupportAuthorType, string> = {
	customer: "Customer",
	staff: "Alethia Support",
	ai: "Assistant",
	system: "System",
};

/** Two-letter avatar initials per author role (customer authors don't render an avatar). */
const ROLE_INITIALS: Record<SupportAuthorType, string> = {
	customer: "CU",
	staff: "AS",
	ai: "AI",
	system: "SY",
};

/**
 * Renders one staff-visible message as a grayscale bubble. Customer messages sit
 * right-aligned (muted surface); staff/AI/system sit left-aligned with a role label,
 * avatar, and timestamp. Internal notes (`is_internal`) break out of the bubble layout
 * into a distinct dashed block flagged "not visible to the customer" so staff never
 * confuse them with a real reply. Bodies preserve author line breaks via `whitespace-pre-wrap`.
 */
function ThreadMessage({ message }: { message: StaffMessage }) {
	const label = message.author_name || ROLE_LABEL[message.author_type];
	const timestamp = format(new Date(message.created_at), "MMM d, yyyy · HH:mm");

	if (message.is_internal) {
		return (
			<div className="rounded-md border border-dashed border-border bg-muted/40 p-3">
				<div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
					<EyeOff className="size-3.5" />
					Internal note — not visible to the customer
				</div>
				<div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
					<span className="font-medium text-foreground">{label}</span>
					<span>{timestamp}</span>
				</div>
				<div className="mt-2 whitespace-pre-wrap text-sm text-foreground">
					{message.body}
				</div>
			</div>
		);
	}

	const isCustomer = message.author_type === "customer";

	return (
		<div
			className={cn(
				"flex flex-col gap-1.5",
				isCustomer ? "items-end" : "items-start",
			)}
		>
			<div
				className={cn(
					"flex items-center gap-2",
					isCustomer && "flex-row-reverse",
				)}
			>
				{!isCustomer && (
					<Avatar className="size-6 rounded-none">
						<AvatarFallback className="rounded-none text-[10px]">
							{ROLE_INITIALS[message.author_type]}
						</AvatarFallback>
					</Avatar>
				)}
				<span className="text-xs font-medium text-foreground">{label}</span>
				<span className="text-xs text-muted-foreground">{timestamp}</span>
			</div>
			<div
				className={cn(
					"max-w-[85%] rounded-md border px-3 py-2 text-sm whitespace-pre-wrap text-foreground",
					isCustomer ? "bg-muted/40" : "bg-background",
				)}
			>
				{message.body}
			</div>
		</div>
	);
}

/**
 * The staff-facing case conversation: the FULL, oldest-first thread including internal
 * notes. Customer and staff/AI/system turns render as grayscale bubbles; internal notes
 * render as distinct dashed blocks.
 */
export function StaffCaseThread({ messages }: { messages: StaffMessage[] }) {
	if (messages.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center gap-1 px-4 py-12 text-center">
				<p className="text-sm font-medium text-foreground">No messages yet</p>
				<p className="text-xs text-muted-foreground">
					Replies and internal notes on this case will appear here.
				</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4 p-4">
			{messages.map((message) => (
				<ThreadMessage key={message.id} message={message} />
			))}
		</div>
	);
}
