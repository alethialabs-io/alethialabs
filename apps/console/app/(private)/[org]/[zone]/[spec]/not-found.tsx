// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Rendered inside AppShell — the spec page calls notFound() below the org layout.

import Link from "next/link";
import { ErrorState } from "@/components/errors/error-state";
import { Button } from "@repo/ui/button";

export default function SpecNotFound() {
	return (
		<ErrorState
			title="Spec not found"
			description="This spec doesn't exist or isn't available in this zone."
			actions={
				<Button asChild size="sm" variant="outline">
					<Link href="/">Back to dashboard</Link>
				</Button>
			}
		/>
	);
}
