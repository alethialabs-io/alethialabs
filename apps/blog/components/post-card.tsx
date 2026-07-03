// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { formatDate, type Post } from "@/lib/posts";

export function PostCard({ post }: { post: Post }) {
	return (
		<Link
			href={`/${post.slug}`}
			className="block border border-border bg-card p-5 no-underline transition-colors hover:border-border-strong"
		>
			<div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
				{formatDate(post.date)} · {post.metadata.readingTime} min read
			</div>
			<h2 className="mt-2 text-xl font-bold tracking-tight text-foreground">{post.title}</h2>
			<p className="mt-2 text-sm text-muted-foreground">{post.excerpt ?? post.description}</p>
			{post.tags.length > 0 && (
				<div className="mt-3 flex flex-wrap gap-2">
					{post.tags.map((t) => (
						<span
							key={t}
							className="border border-border px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground"
						>
							{t}
						</span>
					))}
				</div>
			)}
		</Link>
	);
}
