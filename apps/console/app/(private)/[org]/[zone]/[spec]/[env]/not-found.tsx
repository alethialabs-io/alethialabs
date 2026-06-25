// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Rendered inside AppShell — the env page calls notFound() below the org layout.

import Link from "next/link";
import { ErrorState } from "@/components/errors/error-state";
import { Button } from "@/components/ui/button";

export default function EnvNotFound() {
	return (
		<ErrorState
			title="Environment not found"
			description="This environment doesn't exist or isn't available for this spec."
			actions={
				<Button asChild size="sm" variant="outline">
					<Link href="/">Back to dashboard</Link>
				</Button>
			}
		/>
	);
}
