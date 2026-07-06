// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { defineCollection, defineConfig, s } from "velite";

// Typed MDX posts. Frontmatter is validated by zod (via velite's `s`); the body
// is compiled to a function-body string (`code`) rendered by components/mdx-content.
const posts = defineCollection({
	name: "Post",
	pattern: "posts/**/*.mdx",
	schema: s
		.object({
			title: s.string().max(140),
			description: s.string(),
			date: s.isodate(),
			author: s.string(),
			tags: s.array(s.string()).default([]),
			cover: s.string().optional(),
			excerpt: s.string().optional(),
			draft: s.boolean().default(false),
			path: s.path(),
			code: s.mdx(),
			metadata: s.metadata(), // { readingTime, wordCount }
		})
		.transform((data) => {
			const slug = data.path.replace(/^posts\//, "");
			return { ...data, slug, permalink: `/blog/${slug}` };
		}),
});

export default defineConfig({
	root: "content",
	collections: { posts },
	mdx: {
		// Keep output portable: no remark/rehype extras for now.
	},
});
