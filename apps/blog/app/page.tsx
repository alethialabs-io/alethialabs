// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PostCard } from "@/components/post-card";
import { getPublishedPosts } from "@/lib/posts";

export default function Page() {
	const posts = getPublishedPosts();

	return (
		<div className="mx-auto max-w-3xl px-6 py-12">
			<header className="mb-10">
				<h1 className="text-3xl font-extrabold tracking-tight">Engineering Blog</h1>
				<p className="mt-3 max-w-prose text-muted-foreground">
					Deep dives into how Alethia is built — provisioning, the runner fleet, and the
					architecture behind a multi-cloud control plane you run in your own cloud.
				</p>
			</header>

			{posts.length === 0 ? (
				<p className="text-muted-foreground">No posts yet.</p>
			) : (
				<div className="space-y-4">
					{posts.map((post) => (
						<PostCard key={post.slug} post={post} />
					))}
				</div>
			)}
		</div>
	);
}
