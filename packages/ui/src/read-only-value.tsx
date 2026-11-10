// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";

import { cn } from "./utils";

/**
 * A value the viewer can read but not change — a slug, an id, an address set elsewhere.
 *
 * It is NOT drawn on the input surface. A sunken, bordered box is how the console says "you can
 * type here", so a read-only value drawn that way is a control that ignores the click (#6117,
 * F039: the project URL slug on `/[project]/settings/general` looked exactly like the editable
 * name field above it). This is plain text in the secondary ink, on the page's own background.
 *
 * It keeps the height of a single-line settings control (38px) as a MINIMUM, so a row holding a
 * read-only value lines up with the rows holding inputs; longer content wraps and grows. `mono`
 * sets the value in the mono voice, for identifiers and paths.
 *
 * Make the value copyable by putting a `CopyButton` beside it, not by turning it into an input.
 *
 * @example
 * <ReadOnlyValue mono>/acme/payments-api</ReadOnlyValue>
 */
function ReadOnlyValue({
	mono = false,
	className,
	children,
	...props
}: React.ComponentProps<"div"> & {
	/** Set the value in the mono voice (identifiers, slugs, paths). */
	mono?: boolean;
}) {
	return (
		<div
			data-slot="read-only-value"
			className={cn(
				"flex min-h-[38px] min-w-0 items-center break-words text-text-secondary",
				mono ? "font-mono text-ui-sm" : "text-ui-md",
				className,
			)}
			{...props}
		>
			{children}
		</div>
	);
}

export { ReadOnlyValue };
