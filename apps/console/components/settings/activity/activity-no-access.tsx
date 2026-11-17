// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { RegionRefusal } from "@/components/errors/region-refusal";

/** Rendered by the Activity pages in place of the feed when the caller lacks
 *  `activity:view_activity` (#3932) — the console's one refused render. */
export function ActivityNoAccess() {
	return (
		<div className="p-6">
			<RegionRefusal refusal="forbidden" subject="the activity log" />
		</div>
	);
}
