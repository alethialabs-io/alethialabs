// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org layout calls notFound() before AppShell renders, so this shows full-page
// (no dashboard chrome). Intentionally non-leaky: an unknown org and a forbidden
// org read the same — we never disclose existence.

import Link from "next/link";
import { ErrorState } from "@/components/errors/error-state";
import { Button } from "@repo/ui/button";

export default function OrgNotFound() {
	return (
		<ErrorState
			fullPage
			code="404"
			title="Organization not found"
			description="This organization doesn't exist, or you don't have access to it."
			actions={
				<Button asChild size="sm">
					<Link href="/">Go home</Link>
				</Button>
			}
		/>
	);
}
