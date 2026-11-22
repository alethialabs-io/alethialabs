// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { NewsCard } from "@/components/news/news-card";
import type { NewsKind } from "@/lib/news";
import type { Post } from "@/lib/posts";

/**
 * The card grid under the filter chips: one column on a phone, two, then three. "Load more" is a
 * link to `?page=n+1` (keeping the kind), so it works without JavaScript and a shared URL reopens
 * the same list.
 */
export function NewsGrid({ posts, kind, page, hasMore }: { posts: Post[]; kind: NewsKind | null; page: number; hasMore: boolean }) {
	return (
		<>
			<ul className="grid grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
				{posts.map((post) => (
					<li key={post.slug} className="min-w-0">
						<NewsCard post={post} />
					</li>
				))}
			</ul>
			{hasMore && (
				<div className="mt-10 flex justify-center">
					<Link
						href={{ pathname: "/", query: kind ? { kind, page: page + 1 } : { page: page + 1 } }}
						scroll={false}
						className="border border-border px-5 py-2 text-sm text-text-primary no-underline transition-colors hover:border-border-strong"
					>
						Load more
					</Link>
				</div>
			)}
		</>
	);
}
