// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Short `owner/repo` display name for a git repo URL — the last two path segments with any
 * trailing `.git` stripped. Falls back to the raw URL when it can't be shortened. Shared by
 * the overview repository filter/cards and the design-project source-repo surfaces.
 */
export function repoLabel(url: string): string {
	return (
		url
			.replace(/\.git$/, "")
			.split("/")
			.filter(Boolean)
			.slice(-2)
			.join("/") || url
	);
}
