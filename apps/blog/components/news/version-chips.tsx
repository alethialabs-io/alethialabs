// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { versionChips } from "@/lib/changelog";
import type { Post } from "@/lib/posts";

/** The versions a changelog entry covers, each a mono chip linking to its GitHub release. */
export function VersionChips({ versions }: { versions: Post["versions"] }) {
	const chips = versionChips(versions);
	if (chips.length === 0) return null;
	return (
		<ul aria-label="Versions in this entry" className="flex flex-wrap gap-1.5">
			{chips.map((chip) => (
				<li key={chip.href}>
					<a
						href={chip.href}
						target="_blank"
						rel="noreferrer noopener"
						className="inline-block border border-border-strong px-2 py-0.5 font-mono text-ui-xs text-text-secondary no-underline transition-colors hover:text-text-primary"
					>
						{chip.label} ↗<span className="sr-only"> (opens GitHub in a new tab)</span>
					</a>
				</li>
			))}
		</ul>
	);
}
