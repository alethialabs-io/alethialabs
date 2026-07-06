"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Avatar, AvatarFallback } from "@repo/ui/avatar";
import { cn } from "@repo/ui/utils";
import { format } from "date-fns";
import { EyeOff } from "lucide-react";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
} from "@/components/ai-elements/conversation";
import {
	Message,
	MessageContent,
	MessageResponse,
} from "@/components/ai-elements/message";
import type { SupportAuthorType } from "@/lib/db/schema/enums";
import type { StaffCaseDetail } from "@/lib/queries/support";

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
 * Renders one staff-visible message. Customer messages sit right-aligned; staff/AI/system
 * sit left-aligned with a role label, avatar, and timestamp. Internal notes
 * (`is_internal`) break out of the bubble layout into a distinct muted/bordered block
 * flagged "not visible to the customer" so staff never confuse them with a real reply.
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
				<div className="mt-2 text-sm text-foreground">
					<MessageResponse>{message.body}</MessageResponse>
				</div>
			</div>
		);
	}

	const isCustomer = message.author_type === "customer";

	return (
		<Message from={isCustomer ? "user" : "assistant"}>
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
			<MessageContent>
				<MessageResponse>{message.body}</MessageResponse>
			</MessageContent>
		</Message>
	);
}

/**
 * The staff-facing case conversation: the FULL, oldest-first thread including internal
 * notes. Customer and staff/AI/system turns render as grayscale bubbles; internal notes
 * render as distinct dashed blocks.
 */
export function StaffCaseThread({ messages }: { messages: StaffMessage[] }) {
	return (
		<Conversation className="min-h-0">
			<ConversationContent>
				{messages.length === 0 ? (
					<ConversationEmptyState
						title="No messages yet"
						description="Replies and internal notes on this case will appear here."
					/>
				) : (
					messages.map((message) => (
						<ThreadMessage key={message.id} message={message} />
					))
				)}
			</ConversationContent>
		</Conversation>
	);
}
