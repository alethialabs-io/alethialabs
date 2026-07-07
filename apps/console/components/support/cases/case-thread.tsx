"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Avatar, AvatarFallback } from "@repo/ui/avatar";
import { cn } from "@repo/ui/utils";
import { format } from "date-fns";
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
import type { PublicMessage } from "@/lib/queries/support";

/** The display name shown above each message, keyed by who authored it. */
const ROLE_LABEL: Record<SupportAuthorType, string> = {
	customer: "You",
	staff: "Alethia Support",
	ai: "Assistant",
	system: "System",
};

/** Two-letter avatar initials per author role (customer authors don't render an avatar). */
const ROLE_INITIALS: Record<SupportAuthorType, string> = {
	customer: "ME",
	staff: "AS",
	ai: "AI",
	system: "SY",
};

/**
 * Renders a single support message through the AI-Elements message primitives — the same
 * squared grayscale bubbles + markdown renderer the agent chat uses. Customer messages sit
 * right-aligned as "You"; staff/AI/system sit left-aligned with a role label, avatar, and
 * timestamp.
 */
function ThreadMessage({ message }: { message: PublicMessage }) {
	const isCustomer = message.author_type === "customer";
	const label = message.author_name || ROLE_LABEL[message.author_type];
	const timestamp = format(new Date(message.created_at), "MMM d, yyyy · HH:mm");

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
 * The customer-visible case conversation: an ordered, oldest-first list of public messages
 * rendered as chat bubbles. Empty until the first message lands.
 */
export function CaseThread({ messages }: { messages: PublicMessage[] }) {
	return (
		<Conversation className="min-h-0">
			<ConversationContent>
				{messages.length === 0 ? (
					<ConversationEmptyState
						title="No messages yet"
						description="Replies on this case will appear here."
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
