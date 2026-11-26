"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { useEffect } from "react";
import { ErrorState } from "@repo/ui/error-state";
import { captureException } from "@/lib/analytics/track";

/**
 * The approvals route's error boundary: a render failure below it replaces the list, keeps the shell,
 * and says the one thing a person deciding needs to hear — nothing was decided.
 */
export default function ApprovalsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
	useEffect(() => {
		captureException(error, { boundary: "approvals", digest: error.digest });
	}, [error]);

	return (
		<ErrorState
			title="Couldn't load approvals"
			description="Something went wrong on our side. Requests are safe and nothing was decided."
			actions={
				<Button size="sm" onClick={reset}>
					Try again
				</Button>
			}
		/>
	);
}
