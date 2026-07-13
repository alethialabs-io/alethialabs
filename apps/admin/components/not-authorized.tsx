// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/** The 403 block shown when the caller isn't staff (Cloudflare Access should already have blocked). */
export function NotAuthorized() {
	return (
		<div className="flex min-h-dvh flex-col items-center justify-center gap-2 px-4 text-center">
			<h1 className="text-lg font-medium text-foreground">Not authorized</h1>
			<p className="max-w-sm text-sm text-muted-foreground">
				This dashboard is for Alethia support staff only. If you believe you should have
				access, contact an administrator.
			</p>
		</div>
	);
}
