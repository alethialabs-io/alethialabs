// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Rendered inside AppShell (the zone page calls notFound() below the org layout),
// so the dashboard chrome stays and only the content area shows this panel.

import Link from "next/link";
import { ErrorState } from "@/components/errors/error-state";
import { Button } from "@repo/ui/button";

export default function ZoneNotFound() {
	return (
		<ErrorState
			title="Zone not found"
			description="This zone doesn't exist or isn't available in this organization."
			actions={
				<Button asChild size="sm" variant="outline">
					<Link href="/">Back to dashboard</Link>
				</Button>
			}
		/>
	);
}
