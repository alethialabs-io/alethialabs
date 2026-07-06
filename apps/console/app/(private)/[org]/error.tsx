"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// In-shell error boundary for the org tree. Render errors below the org layout
// land here, so the dashboard chrome (AppShell) stays mounted and only the content
// area shows the error + retry — not a full-page takeover.

import { useEffect } from "react";
import { ErrorState } from "@/components/errors/error-state";
import { Button } from "@repo/ui/button";

export default function OrgError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		console.error("[dashboard] error:", error.digest ?? error.message, error);
	}, [error]);

	return (
		<ErrorState
			title="Couldn't load this page"
			description="Something went wrong while loading your organization. Try again."
			actions={
				<Button size="sm" onClick={reset}>
					Try again
				</Button>
			}
		/>
	);
}
