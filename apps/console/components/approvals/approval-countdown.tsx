"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { formatDate, formatMinutes } from "@repo/format";
import { cn } from "@repo/ui/utils";
import { useSecondsClock } from "@/components/jobs/columns";

/** Under this many milliseconds left, a request is "expiring soon" (spec §1.4). */
const EXPIRING_SOON_MS = 5 * 60 * 1000;

/** What is left of a waiting request's window, read against `now`. */
export interface Remaining {
	/** Milliseconds left; 0 or less once it has expired. */
	ms: number;
	/** Inside the last five minutes, and not yet expired. */
	soon: boolean;
	expired: boolean;
}

/** The window left before `expiresAt`, at `now` (epoch ms). */
export function remainingAt(expiresAt: string, now: number): Remaining {
	const ms = Date.parse(expiresAt) - now;
	return { ms, soon: ms > 0 && ms <= EXPIRING_SOON_MS, expired: ms <= 0 };
}

/** `m:ss`, for the last five minutes. */
function clockFace(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * A waiting request's countdown: "Expires in 52 min", then an inverted `m:ss` chip in the last five
 * minutes, then "Expired". Before hydration there is no clock, so it shows the absolute time instead —
 * never a number the server and the browser would disagree about.
 *
 * NOT a live region on its own (spec §1.4, accessibility): a ticking announcement every second would
 * drown everything else. `announce` adds ONE polite status that speaks twice — when five minutes are
 * left, and at expiry — and is used once per screen, by the sheet.
 */
export function ApprovalCountdown({
	expiresAt,
	announce = false,
	className,
}: {
	expiresAt: string;
	announce?: boolean;
	className?: string;
}) {
	const now = useSecondsClock();
	if (now === null) {
		return (
			<time dateTime={expiresAt} className={cn("text-ui-sm text-text-secondary", className)}>
				Until {formatDate(expiresAt, "time")}
			</time>
		);
	}
	const left = remainingAt(expiresAt, now);
	const message = left.expired ? "This request has expired." : left.soon ? "Five minutes left to decide this request." : "";
	return (
		<>
			{left.expired ? (
				<span data-state="expired" className={cn("text-ui-sm text-text-secondary", className)}>
					Expired
				</span>
			) : left.soon ? (
				<span
					data-state="soon"
					className={cn(
						"inline-flex items-center rounded bg-foreground px-1.5 font-mono text-ui-sm text-background tabular-nums",
						className,
					)}
				>
					<span className="sr-only">Expires in </span>
					{clockFace(left.ms)}
				</span>
			) : (
				<span data-state="waiting" className={cn("text-ui-sm text-text-secondary tabular-nums", className)}>
					Expires in {formatMinutes(left.ms / 60000)}
				</span>
			)}
			{announce ? (
				<span role="status" aria-live="polite" className="sr-only">
					{message}
				</span>
			) : null}
		</>
	);
}
