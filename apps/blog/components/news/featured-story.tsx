// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { AlethiaMark } from "@repo/brand/lockup";
import { KIND_LABELS, newsDate, postSummary } from "@/lib/news";
import type { Post } from "@/lib/posts";

/**
 * The featured story at the top of /news: a typographic cover (the [·] mark on a sunken panel,
 * never a photo) beside the kind, date, title, summary and a read link. Stacks on a phone.
 */
export function FeaturedStory({ post }: { post: Post }) {
	const cta = post.kind === "announcement" ? "Read the announcement" : "Read the post";
	return (
		<article className="grid border border-border bg-surface md:min-h-[300px] md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
			<div
				aria-hidden
				className="grid min-h-[200px] place-items-center border-b border-border bg-surface-sunken text-text-secondary md:border-r md:border-b-0"
			>
				<AlethiaMark size={120} />
			</div>
			<div className="grid content-end gap-3 p-7">
				<div className="flex flex-wrap items-center gap-3">
					<span className="border border-border-strong px-2 py-0.5 font-mono text-ui-2xs uppercase tracking-[0.12em] text-text-secondary">
						{KIND_LABELS[post.kind]}
					</span>
					<time dateTime={post.date} className="font-mono text-ui-sm text-text-tertiary">
						{newsDate(post.date)}
					</time>
				</div>
				<h2 className="font-grotesk text-display-xs font-semibold leading-tight tracking-[-0.02em] text-text-primary">
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
