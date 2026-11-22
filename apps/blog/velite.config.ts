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
			// An optional real image, rendered GRAYSCALE (alethia-design: photos only in grayscale).
			// Either an in-repo file under public/static, written with the basePath
			// ("/news/static/launch.jpg"), or a path on the assets host, relative to
			// https://assets.alethialabs.io/news/ ("2026/launch.jpg"). Without one, the post gets
			// generated cover art (@repo/brand/cover), seeded from its slug and kind.
			cover: s
				.string()
				.regex(/^(?!.*\.\.)(?:\/news\/static\/|(?![a-z][a-z0-9+.-]*:|\/))[\w./-]+\.(?:avif|jpe?g|png|webp)$/i, {
					message: 'cover must be "/news/static/<file>" or a path relative to https://assets.alethialabs.io/news/',
				})
				.optional(),
			excerpt: s.string().optional(),
			// Which tier of news this is: drives the /news filter chips, the cover motif and the
			// featured fallback. Most posts are deep dives, so that is the default. `changelog` is a
			// curated, dated roll-up (headline, then New / Improved / Fixed) and is the ONLY source of
			// the changelog: raw GitHub release rows are not shown on News.
			kind: s.enum(["announcement", "product", "changelog", "engineering", "company"]).default("engineering"),
			// For a changelog entry: the CLI and runner versions it covers, shown as chips linking to
			// their GitHub releases.
			versions: s
				.object({
					cli: s.string().regex(/^v?\d+\.\d+\.\d+$/).optional(),
					runner: s.string().regex(/^v?\d+\.\d+\.\d+$/).optional(),
				})
				.optional(),
			// Pins the post to the /news hero; the newest featured post wins, and other featured
			// posts lead the secondary row.
			featured: s.boolean().default(false),
			// Card text for the index and the feed; falls back to `excerpt`, then `description`.
			summary: s.string().max(280).optional(),
			draft: s.boolean().default(false),
			path: s.path(),
			code: s.mdx(),
			metadata: s.metadata(), // { readingTime, wordCount }
		})
		.transform((data) => {
			const slug = data.path.replace(/^posts\//, "");
			return { ...data, slug, permalink: `/news/${slug}` };
		}),
});

export default defineConfig({
	root: "content",
	collections: { posts },
	mdx: {
		// Keep output portable: no remark/rehype extras for now.
	},
});
