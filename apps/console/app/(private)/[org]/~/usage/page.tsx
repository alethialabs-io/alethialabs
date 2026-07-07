// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { UsagePanel } from "@/components/settings/usage/usage-panel";

/** Usage: seats, runner-minutes, projects consumed this period (+ AI when it lands). */
export default function UsagePage() {
	return (
		<div className="mx-auto w-full min-w-0 max-w-[1200px]">
			<UsagePanel />
		</div>
	);
}
