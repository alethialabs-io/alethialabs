"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Vendored from the shadcn registry (`message-scroller`, new-york-v4) over the base-ui-style
// `@shadcn/react/message-scroller` primitive: a virtualized-feel chat scroller that sticks to
// the bottom while streaming, releases on scroll-up, and culls off-screen turns via
// `content-visibility`. Imports rewired to `@repo/ui/*` and the registry's scrollbar-plugin /
// logical-inset utilities trimmed for this grayscale/squared system.

import type * as React from "react";
import {
	MessageScroller as MessageScrollerPrimitive,
	useMessageScroller,
	useMessageScrollerScrollable,
	useMessageScrollerVisibility,
} from "@shadcn/react/message-scroller";
import { ArrowDownIcon } from "lucide-react";
import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";

/** Provides autoscroll + scroll-position state to the scroller subtree. */
function MessageScrollerProvider(
	props: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>,
) {
	return <MessageScrollerPrimitive.Provider {...props} />;
}

/** The scroller root (positioning context for the scroll-to-latest button). */
function MessageScroller({
	className,
	...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Root>) {
	return (
		<MessageScrollerPrimitive.Root
			data-slot="message-scroller"
			className={cn(
				"group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden",
				className,
			)}
			{...props}
		/>
	);
}

/** The scrollable viewport. */
function MessageScrollerViewport({
	className,
	...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
	return (
		<MessageScrollerPrimitive.Viewport
			data-slot="message-scroller-viewport"
			className={cn(
				"size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain contain-content",
				className,
			)}
			{...props}
		/>
	);
}

/** The turns column (grows to fill; sticks content to the bottom). */
function MessageScrollerContent({
	className,
	...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Content>) {
	return (
		<MessageScrollerPrimitive.Content
			data-slot="message-scroller-content"
			className={cn("flex h-max min-h-full flex-col gap-8", className)}
			{...props}
		/>
	);
}

/** One turn — the `content-visibility` culling unit. Set `scrollAnchor` on turn boundaries
 * so a new turn anchors correctly, and `messageId` so it can be scrolled to by id. */
function MessageScrollerItem({
	className,
	scrollAnchor = false,
	...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Item>) {
	return (
		<MessageScrollerPrimitive.Item
			data-slot="message-scroller-item"
			scrollAnchor={scrollAnchor}
			className={cn(
				"min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]",
				className,
			)}
			{...props}
		/>
	);
}

/** The scroll-to-latest affordance — shown only when the viewport is scrolled away from the
 * anchored edge; re-engages autoscroll on click. */
function MessageScrollerButton({
	direction = "end",
	className,
	children,
	render,
	variant = "secondary",
	size = "icon-sm",
	...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Button> &
	Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
	return (
		<MessageScrollerPrimitive.Button
			data-slot="message-scroller-button"
			data-direction={direction}
			direction={direction}
			className={cn(
				"absolute bottom-4 left-1/2 -translate-x-1/2 rounded-none border border-border bg-background text-foreground shadow-sm transition-[transform,opacity] duration-200 hover:bg-muted hover:text-foreground",
				"data-[active=false]:pointer-events-none data-[active=false]:translate-y-2 data-[active=false]:opacity-0",
				"data-[active=true]:translate-y-0 data-[active=true]:opacity-100",
				"data-[direction=start]:top-4 data-[direction=start]:bottom-auto data-[direction=start]:[&_svg]:rotate-180",
				className,
			)}
			render={render ?? <Button variant={variant} size={size} />}
			{...props}
		>
			{children ?? (
				<>
					<ArrowDownIcon />
					<span className="sr-only">
						{direction === "end" ? "Scroll to latest" : "Scroll to start"}
					</span>
				</>
			)}
		</MessageScrollerPrimitive.Button>
	);
}

export {
	MessageScrollerProvider,
	MessageScroller,
	MessageScrollerViewport,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerButton,
	useMessageScroller,
	useMessageScrollerScrollable,
	useMessageScrollerVisibility,
};
