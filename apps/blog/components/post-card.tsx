// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { Badge } from "@repo/ui/badge";
import { Card } from "@repo/ui/card";

import { formatDate, type Post } from "@/lib/posts";

/**
 * One post in the index.
 *
 * Was a hand-rolled card and hand-rolled tag chips — the same border/surface/hover
 * recipe the shared `Card` already carries, and the same mono pill the rest of the
 * app expresses as `Badge` + `vx-badge-mono`. It also used `font-bold`/`font-extrabold`,
 * which appears nowhere else in the system; headings are 600.
 */
export function PostCard({ post }: { post: Post }) {
	return (
		<Link href={`/${post.slug}`} className="block no-underline">
			<Card interactive className="gap-0 rounded-lg p-5">
				<div className="vx-eyebrow">
					{formatDate(post.date)} · {post.metadata.readingTime} min read
				</div>
					<h2 className="mt-2 font-grotesk text-xl font-semibold tracking-[-0.02em] text-text-primary">
					{post.title}
				</h2>
				<p className="mt-2 text-sm text-text-tertiary">{post.excerpt ?? post.description}</p>
				{post.tags.length > 0 && (
				<div className="mt-3 flex flex-wrap gap-2">
					{post.tags.map((t) => (
						<Badge key={t} variant="outline" className="vx-badge-mono">
							{t}
						</Badge>
					))}
				</div>
				)}
			</Card>
		</Link>
	);
}
