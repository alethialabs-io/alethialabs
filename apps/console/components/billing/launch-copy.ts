// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the console's upgrade surfaces say once the server has told them nothing is on sale
// (#6906, REL-L3). The server's `billing.salesOpen` answers ONE question — can a sale be taken
// here, honouring the release gate's test-mode waiver — and `paidLaunchState()` answers the other:
// has a date been promised. The sentence for each comes from `@repo/plan-catalog`'s
// `notOnSaleCopy`, the same words the public pricing page shows, so no sheet writes its own.

import { formatDate } from "@repo/format";
import { type LaunchState, paidLaunchState } from "@repo/legal/launch";
import { type NotOnSaleCopy, notOnSaleCopy } from "@repo/plan-catalog";

/**
 * The not-on-sale sentences for the launch state: "Pro is available from 15 Feb 2027" when a date
 * is announced, "Pro isn't on sale yet" when none is.
 *
 * Only called once the server has said nothing is on sale, so an `open` state here means this
 * bundle and the server disagree (a deploy in flight). The server is the authority on whether a
 * sale can be taken, and it said no, so that reads as closed.
 *
 * The date is a calendar day, not an instant, so it is formatted pinned to UTC: an unpinned zone
 * would show a visitor west of Greenwich the day before.
 *
 * @param state the launch state; defaults to today's `paidLaunchState().paid`.
 */
export function salesClosedCopy(state: LaunchState = paidLaunchState().paid): NotOnSaleCopy {
	return notOnSaleCopy(state.status === "open" ? { status: "closed" } : state, (iso) =>
		formatDate(iso, "date", "UTC"),
	);
}
