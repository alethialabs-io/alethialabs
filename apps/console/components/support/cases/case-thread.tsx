"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Avatar, AvatarFallback } from "@repo/ui/avatar";
import { EmptyState } from "@repo/ui/empty";
import { cn } from "@repo/ui/utils";
import { useEffect } from "react";
import {
	Message,
	MessageContent,
	MessageResponse,
} from "@/components/ai-elements/message";
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
	useMessageScroller,
} from "@/components/ai-elements/message-scroller";
import type { SupportAuthorType } from "@/lib/db/schema/enums";
import type { PublicMessage } from "@/lib/queries/support";
import { OPTIMISTIC_ID_PREFIX } from "./case-composer";
import { CaseTime } from "./case-time";

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
						<AvatarFallback className="rounded-none text-ui-2xs">
							{ROLE_INITIALS[message.author_type]}
						</AvatarFallback>
					</Avatar>
				)}
				<span className="text-xs font-medium text-foreground">{label}</span>
				{/* In the viewer's time zone, so only after hydration (the server's zone is not theirs). */}
				<CaseTime value={message.created_at} style="datetime" className="text-xs text-muted-foreground" />
			</div>
			<MessageContent>
				<MessageResponse>{message.body}</MessageResponse>
			</MessageContent>
		</Message>
	);
}

/**
 * Scrolls to the newest message when it is the viewer's own send. Everything else is the
 * scroller's `autoScroll`: a reply that lands while the viewer is at the bottom is followed, and
 * one that lands while they are reading history is not. Their own send is the exception — they
 * just acted, so the thread shows the result wherever they had scrolled to.
 */
function FollowOwnSend({ lastMessageId }: { lastMessageId: string | undefined }) {
	const { scrollToEnd } = useMessageScroller();
	useEffect(() => {
		if (lastMessageId?.startsWith(OPTIMISTIC_ID_PREFIX)) scrollToEnd({ behavior: "smooth" });
	}, [lastMessageId, scrollToEnd]);
	return null;
}

/**
 * The customer-visible case conversation: an ordered, oldest-first list of public messages
 * rendered as chat bubbles, in a bounded scroller that opens at the newest message. Empty until
 * the first message lands.
 */
export function CaseThread({ messages }: { messages: PublicMessage[] }) {
	return (
		<MessageScrollerProvider autoScroll defaultScrollPosition="end">
			<FollowOwnSend lastMessageId={messages.at(-1)?.id} />
			<MessageScroller>
				{/* Bounded, so a long thread scrolls inside the case rather than pushing the composer
				    below the fold (a smaller cap on a phone keeps it reachable) — without a bound the viewport is
				    as tall as its content and there is nothing to stick to the bottom of. `overscroll-auto`
				    because the thread sits in a scrolling page: a swipe at its edge carries on to the page. */}
				<MessageScrollerViewport aria-label="Case conversation" className="max-h-[60dvh] overscroll-auto scrollbar-thin sm:max-h-[70dvh]">
					<MessageScrollerContent className="p-4">
						{messages.length === 0 ? (
							<EmptyState
								level={3}
								title="No messages yet"
								description="Replies on this case will appear here."
							/>
						) : (
							messages.map((message) => (
								<MessageScrollerItem key={message.id} messageId={message.id}>
									<ThreadMessage message={message} />
								</MessageScrollerItem>
							))
						)}
					</MessageScrollerContent>
				</MessageScrollerViewport>
				<MessageScrollerButton />
			</MessageScroller>
		</MessageScrollerProvider>
	);
}
