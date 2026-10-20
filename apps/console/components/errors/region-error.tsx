// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No "use client": it renders from server and client components alike. `onRetry` is a function,
// so a server component cannot pass one, and a retry is always a client concern anyway.

import { CircleAlert } from "lucide-react";

import { Button } from "@repo/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@repo/ui/empty";
import { cn } from "@repo/ui/utils";

interface RegionErrorProps {
	/** What failed, in the reader's terms. Defaults to a generic "Couldn't load this". */
	title?: string;
	/** One line on what to do. Never a raw error message: those can carry server detail. */
	description?: string;
	/** Re-run the failed read. Omit it only when there is nothing to retry. */
	onRetry?: () => void;
	className?: string;
}

/**
 * The error render of ONE data region: a table, a panel, a card. Not a page.
 *
 * A read that failed must not look like a read that found nothing. Before this, a failed query
 * fell through to the region's empty state ("No results.", "No activity yet"), which tells the
 * viewer something false about their data. So this is built on the `EmptyState` primitives, to
 * sit in the same place at the same size, but with its own mark and copy and `data-state="error"`,
 * and it is announced (`role="alert"`) because it replaces content the viewer was waiting for.
 *
 * A whole route that fails is `ErrorState` in a route's `error.tsx`. An expected refusal
 * (forbidden, not found, plan-gated) is its own render too, and none of them is this.
 *
 * @example
 * if (query.isError) return <RegionError onRetry={() => query.refetch()} />;
 */
export function RegionError({
	title = "Couldn't load this",
	description = "Something went wrong while loading. Try again.",
	onRetry,
	className,
}: RegionErrorProps) {
	return (
		<Empty
			data-slot="region-error"
			data-state="error"
			role="alert"
			className={cn("p-6 md:p-6", className)}
		>
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<CircleAlert aria-hidden />
				</EmptyMedia>
				<EmptyTitle className="text-ui-lg">{title}</EmptyTitle>
				<EmptyDescription className="text-ui-md">{description}</EmptyDescription>
			</EmptyHeader>
			{onRetry ? (
				<EmptyContent>
					<Button variant="outline" size="sm" onClick={onRetry}>
						Try again
					</Button>
				</EmptyContent>
			) : null}
		</Empty>
	);
}
