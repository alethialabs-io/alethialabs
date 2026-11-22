// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { PostCover } from "@/components/news/post-cover";
import { PostMeta } from "@/components/news/post-meta";
import { NewsCard } from "@/components/news/news-card";
import { postSummary } from "@/lib/news";
import type { Post } from "@/lib/posts";

/**
 * The hero at the top of /news: a large cover beside kind · date, the title, the summary and a
 * read link; it stacks on a phone. The cover is the post's real image rendered grayscale when it
 * has one, and otherwise its generated grayscale art (@repo/brand/cover) — never a colour photo.
 */
export function FeaturedStory({ post }: { post: Post }) {
	const cta = post.kind === "announcement" ? "Read the announcement" : "Read the post";
	return (
		<article className="grid gap-6 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] md:items-end md:gap-10">
			<Link href={`/${post.slug}`} tabIndex={-1} aria-hidden className="block">
				<PostCover post={post} aspect="hero" priority sizes="(min-width: 768px) 60vw, 100vw" />
			</Link>
			<div className="grid content-end gap-4">
				<PostMeta post={post} />
				<h2 className="font-grotesk text-display-sm font-semibold leading-tight tracking-[-0.03em] text-text-primary">
					<Link href={`/${post.slug}`} className="no-underline hover:underline hover:underline-offset-4">
						{post.title}
					</Link>
				</h2>
				<p className="text-text-secondary">{postSummary(post)}</p>
				<Link
					href={`/${post.slug}`}
					className="justify-self-start border border-border px-4 py-2 text-sm text-text-primary no-underline transition-colors hover:border-border-strong"
				>
					{cta} →
				</Link>
			</div>
		</article>
	);
}

/** The secondary featured row: up to three cards under the hero, ruled off from the list below. */
export function FeaturedRow({ posts }: { posts: Post[] }) {
	if (posts.length === 0) return null;
	return (
		<section aria-label="More featured stories" className="mt-12 border-t border-border pt-8">
			<ul className="grid grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
				{posts.map((post) => (
					<li key={post.slug} className="min-w-0">
						<NewsCard post={post} />
					</li>
				))}
			</ul>
		</section>
	);
}
