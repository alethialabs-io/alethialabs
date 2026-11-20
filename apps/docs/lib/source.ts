// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { docs } from 'fumadocs-mdx:collections/server';
import { type InferPageType, loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons';

const content = docs.toFumadocsSource();

/** True unless the file is a page whose frontmatter says `availability: hidden` (see source.config.ts). */
function isPublished(file: (typeof content.files)[number]): boolean {
  return file.type !== 'page' || file.data.availability !== 'hidden';
}

// See https://fumadocs.dev/docs/headless/source-api for more info.
// Hidden pages are dropped HERE, once: the page tree, search (app/api/search), llms-full.txt and the
// Markdown route (app/llms.mdx) all read this loader, so none of them can still serve one.
export const source = loader({
  baseUrl: '/',
  source: { ...content, files: content.files.filter(isPublished) },
  plugins: [lucideIconsPlugin()],
});

export function getPageImage(page: InferPageType<typeof source>) {
  const segments = [...page.slugs, 'image.png'];

  return {
    segments,
    url: `/og/${segments.join('/')}`,
  };
}

export async function getLLMText(page: InferPageType<typeof source>) {
  const processed = await page.data.getText('processed');

  return `# ${page.data.title}

${processed}`;
}
