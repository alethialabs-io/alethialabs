// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";

import { cn } from "./utils";

/**
 * The mono count that sits beside a section heading.
 *
 * `apps/console/lib/query/README.md` has required this since the filter standard was written —
 * "Result counts live in the count pill next to the section heading — never 'N of M' prose in the
 * bar" — but no component backed it, so the one implementation lived privately inside an agent
 * panel and every other page wrote prose instead.
 *
 * Renders nothing when `count` is null or undefined, so a page can pass a still-loading query
 * result straight through without a ternary at the call site. A count of `0` DOES render: "0" is
 * a result, and hiding it is how an empty filtered list comes to look like a broken one.
 */
function CountPill({
	count,
	className,
	...props
}: React.ComponentProps<"span"> & { count: number | null | undefined }) {
	if (count === null || count === undefined) return null;
	return (
		<span
			data-slot="count-pill"
			className={cn(
				"inline-flex items-center rounded-sm bg-surface-muted px-1.5 py-0.5 font-mono text-[0.6875rem] leading-none text-text-tertiary tabular-nums",
				className,
			)}
			{...props}
		>
			{count.toLocaleString()}
		</span>
	);
}

export { CountPill };
