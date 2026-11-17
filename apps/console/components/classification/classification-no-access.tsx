// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { RegionRefusal } from "@/components/errors/region-refusal";

/**
 * The Classification page for a viewer the taxonomy read refused (`org:view`, #6129): its own
 * render — distinct from an empty taxonomy (the blank slate), from a plan gate and from a failure
 * (RUBRIC B4). The console's one refused render, as every other settings page shows it.
 */
export function ClassificationNoAccess() {
	return (
		<div className="p-6">
			<RegionRefusal refusal="forbidden" subject="classification" />
		</div>
	);
}
