// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Neutral loader for the project segment (the bare project only redirects to Architecture, and the
 * env/usage/settings views load quickly). The Architecture route has its own canvas skeleton; the
 * jobs/clusters routes their own grids.
 */
export default function ProjectLoading() {
	return (
		<div className="flex min-h-[50vh] items-center justify-center">
			<div className="h-6 w-6 animate-spin rounded-full border-2 border-foreground border-t-transparent" />
		</div>
	);
}
