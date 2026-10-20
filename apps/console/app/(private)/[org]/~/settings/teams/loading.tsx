// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PanelSkeleton } from "@/components/skeletons/page-skeletons";
import { PageToolbarSkeleton } from "@repo/ui/page-toolbar";

/** Instant skeleton for the settings/teams route: its toolbar (count, copy, one action), then the panel. */
export default function TeamsLoading() {
	return (
		<div>
			<PageToolbarSkeleton className="mb-4" count actions={1} />
			<PanelSkeleton lines={5} />
		</div>
	);
}
