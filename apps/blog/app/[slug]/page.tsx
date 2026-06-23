// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { MDXContent } from "@/components/mdx-content";
import { formatDate, getPost, getPublishedPosts } from "@/lib/posts";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

export function generateStaticParams() {
	return getPublishedPosts().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata(props: PageProps<"/[slug]">): Promise<Metadata> {
	const { slug } = await props.params;
	const post = getPost(slug);
	if (!post) return {};
	return { title: post.title, description: post.description };
}

export default async function Page(props: PageProps<"/[slug]">) {
	const { slug } = await props.params;
	const post = getPost(slug);
	if (!post) notFound();

	return (
		<article className="mx-auto max-w-3xl px-6 py-12">
			<Link href="/" className="text-sm text-muted-foreground no-underline hover:text-foreground">
				← All posts
			</Link>

			<h1 className="mt-6 text-3xl font-extrabold tracking-tight sm:text-4xl">{post.title}</h1>
			<div className="mt-3 text-xs font-mono uppercase tracking-wider text-muted-foreground">
				{formatDate(post.date)} · {post.author} · {post.metadata.readingTime} min read
			</div>

			<div className="prose mt-8">
				<MDXContent code={post.code} />
			</div>

			<footer className="mt-12 border-t border-border pt-6 text-sm text-muted-foreground">
				<a
					href={`https://github.com/alethialabs-io/alethialabs/blob/main/apps/blog/content/posts/${post.slug}.mdx`}
					target="_blank"
					rel="noreferrer noopener"
					className="hover:text-foreground"
				>
					Edit this post on GitHub
				</a>
			</footer>
		</article>
	);
}
