// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { Lock } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

/**
 * What a CLOSED case shows where the composer goes (F045): it takes no replies, and `action` is the
 * one way forward. ONE component for the case view (the reopen button) and its loading form (a
 * placeholder of that button's size), so a closed case's skeleton is the notice's own frame and
 * copy — it wraps where the page's does — and the two cannot drift (#6354, B2).
 */
export function CaseClosedNotice({
	action,
	...props
}: { action: ReactNode } & Omit<ComponentProps<typeof Alert>, "children">) {
	return (
		<Alert role="status" {...props}>
			<Lock />
			<AlertTitle>This case is closed</AlertTitle>
			<AlertDescription>
				<p>
					It no longer takes replies. Reopen it to continue the conversation, or open a new case
					for a different issue.
				</p>
				{action}
			</AlertDescription>
		</Alert>
	);
}
