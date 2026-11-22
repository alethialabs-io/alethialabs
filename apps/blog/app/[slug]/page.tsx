// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { MDXContent } from "@/components/mdx-content";
import { NewsCard } from "@/components/news/news-card";
import { PostCover } from "@/components/news/post-cover";
import { VersionChips } from "@/components/news/version-chips";
import { KIND_LABELS, newsDate, postSummary, relatedPosts } from "@/lib/news";
import { getPost, getPublishedPosts } from "@/lib/posts";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

export function generateStaticParams() {
	return getPublishedPosts().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
	const { slug } = await props.params;
	const post = getPost(slug);
	if (!post) return {};
	// The OG image is the sibling opengraph-image.tsx, which Next attaches by convention.
	return { title: post.title, description: post.description, openGraph: { type: "article", publishedTime: post.date } };
}

/**
 * One post: back link, the mono meta line, the title and summary, the hero cover, the body, then
 * a row of related posts. A changelog entry also carries its version chips and a link to the full
 * changelog.
 */
export default async function Page(props: { params: Promise<{ slug: string }> }) {
	const { slug } = await props.params;
	const post = getPost(slug);
	if (!post) notFound();
	const related = relatedPosts(post, getPublishedPosts());

	return (
		<>
			<article className="vx-wrap pt-12 pb-16">
				<div className="mx-auto max-w-3xl">
					<Link href={post.kind === "changelog" ? "/changelog" : "/"} className="text-sm text-text-secondary no-underline hover:text-text-primary">
						← {post.kind === "changelog" ? "Changelog" : "All news"}
					</Link>
					<div className="mt-8 font-mono text-ui-xs uppercase tracking-[0.12em] text-text-tertiary">
						<span className="text-text-secondary">{KIND_LABELS[post.kind]}</span> · <time dateTime={post.date}>{newsDate(post.date)}</time> ·{" "}
						{post.author} · {post.metadata.readingTime} min read
					</div>
					<h1 className="mt-4 font-grotesk text-display-sm font-semibold leading-tight tracking-[-0.03em] text-text-primary sm:text-display-md">
						{post.title}
					</h1>
					<p className="mt-4 text-lg text-text-secondary">{postSummary(post)}</p>
					{post.versions && (
						<div className="mt-5">
							<VersionChips versions={post.versions} />
						</div>
					)}
				</div>

				<div className="mx-auto mt-10 max-w-5xl">
					<PostCover post={post} aspect="hero" priority sizes="(min-width: 1024px) 1024px, 100vw" />
				</div>

				<div className="vx-prose mx-auto mt-10 max-w-3xl">
					<MDXContent code={post.code} />
				</div>

				<footer className="mx-auto mt-12 max-w-3xl border-t border-border pt-6 text-sm text-text-secondary">
					<a
						href={`https://github.com/alethialabs-io/alethialabs/blob/main/apps/blog/content/posts/${post.slug}.mdx`}
						target="_blank"
						rel="noreferrer noopener"
						className="hover:text-text-primary"
					>
						Edit this post on GitHub
					</a>
				</footer>
			</article>

			{related.length > 0 && (
				<section aria-labelledby="related" className="border-t border-border">
					<div className="vx-wrap py-14">
						<h2 id="related" className="mb-8 font-grotesk text-ui-xl font-semibold text-text-primary">
							Related
						</h2>
						<ul className="grid grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
							{related.map((p) => (
								<li key={p.slug} className="min-w-0">
									<NewsCard post={p} />
								</li>
							))}
						</ul>
					</div>
				</section>
			)}
		</>
	);
}
