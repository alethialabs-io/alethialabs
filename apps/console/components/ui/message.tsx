// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Vendored from the shadcn registry (`message`, new-york-v4). Row-aligned message layout
// (`align` start/end) whose content column wrap-breaks and end-aligns for the user's turns.
// Imports rewired to `@repo/ui/*`. Pairs with `./bubble` + `./message-scroller`.

import type * as React from "react";
import { cn } from "@repo/ui/utils";

/** A message row — content column, reversed for the user's (end-aligned) turns. */
function Message({
	className,
	align = "start",
	...props
}: React.ComponentProps<"div"> & { align?: "start" | "end" }) {
	return (
		<div
			data-slot="message"
			data-align={align}
			className={cn(
				"group/message relative flex w-full min-w-0 gap-2 text-sm data-[align=end]:flex-row-reverse",
				className,
			)}
			{...props}
		/>
	);
}

/** The message's content column — stacks the bubble/parts + footer, end-aligned for the user. */
function MessageContent({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="message-content"
			className={cn(
				"flex w-full min-w-0 flex-col gap-2.5 wrap-break-word group-data-[align=end]/message:*:data-slot:self-end",
				className,
			)}
			{...props}
		/>
	);
}

export { Message, MessageContent };
