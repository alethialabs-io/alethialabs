"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// In-shell error boundary for the project workspace. Render errors below the project layout land
// here — closer than the org boundary — so failures on a project view show project-appropriate copy
// and a retry, keeping the app shell + project sidebar mounted instead of a full-page takeover.

import { useEffect } from "react";
import { ErrorState } from "@/components/errors/error-state";
import { Button } from "@repo/ui/button";

export default function ProjectError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		console.error("[project] error:", error.digest ?? error.message, error);
	}, [error]);

	return (
		<ErrorState
			title="Couldn't load this page"
			description="Something went wrong while loading this project. Try again."
			actions={
				<Button size="sm" onClick={reset}>
					Try again
				</Button>
			}
		/>
	);
}
