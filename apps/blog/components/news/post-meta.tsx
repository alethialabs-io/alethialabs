// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { KIND_LABELS, newsDate } from "@/lib/news";
import type { Post } from "@/lib/posts";

/** The mono meta line every card and hero carries: KIND · date. */
export function PostMeta({ post, className = "" }: { post: Pick<Post, "kind" | "date">; className?: string }) {
	return (
		<div className={`flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-ui-xs uppercase tracking-[0.12em] ${className}`}>
			<span className="text-text-secondary">{KIND_LABELS[post.kind]}</span>
			<span aria-hidden className="text-text-tertiary">
				·
			</span>
			<time dateTime={post.date} className="text-text-tertiary">
				{newsDate(post.date)}
			</time>
		</div>
	);
}
