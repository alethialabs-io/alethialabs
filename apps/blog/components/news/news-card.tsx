// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { PostCover } from "@/components/news/post-cover";
import { PostMeta } from "@/components/news/post-meta";
import { postSummary } from "@/lib/news";
import type { Post } from "@/lib/posts";

/**
 * One card: cover (4:3), kind · date, title, summary. The whole card is one link, so the target
 * is large on a phone and a screen reader hears the title once.
 */
export function NewsCard({ post, headingLevel = 3 }: { post: Post; headingLevel?: 2 | 3 }) {
	const Heading = headingLevel === 2 ? "h2" : "h3";
	return (
		<article className="min-w-0">
			<Link href={`/${post.slug}`} className="group flex flex-col gap-3 no-underline">
				<PostCover post={post} aspect="card" sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw" />
				<PostMeta post={post} />
				<Heading className="font-grotesk text-ui-xl font-semibold leading-snug tracking-[-0.015em] text-text-primary [overflow-wrap:anywhere] group-hover:underline group-hover:underline-offset-4">
					{post.title}
				</Heading>
				<p className="line-clamp-3 text-sm text-text-secondary">{postSummary(post)}</p>
			</Link>
		</article>
	);
}
