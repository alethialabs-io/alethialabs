// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig, defineDocs, frontmatterSchema, metaSchema } from 'fumadocs-mdx/config';

/**
 * `availability: hidden` keeps a page in the tree but out of the site: lib/source.ts drops it from
 * the page tree, search, llms-full.txt and the Markdown route, and scripts/check-links.mjs treats
 * it as no page. It is how the docs follow a cloud the product hides (packages/core/catalog). The
 * value is checked here, so a typo fails the build instead of publishing the page.
 *
 * The field reuses the schema's own optional-string type because this app has no direct `zod`
 * dependency to build an enum from.
 */
const availability = frontmatterSchema.shape.description.refine(
  (value) => value === undefined || value === 'available' || value === 'hidden',
  { message: 'availability must be "available" or "hidden"' },
);

// You can customise Zod schemas for frontmatter and `meta.json` here
// see https://fumadocs.dev/docs/mdx/collections
export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: frontmatterSchema.extend({ availability }),
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

export default defineConfig({
  mdxOptions: {
    // MDX options
  },
});
