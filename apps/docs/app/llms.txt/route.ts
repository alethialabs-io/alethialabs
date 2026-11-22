// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Folder, Item, Node } from 'fumadocs-core/page-tree';
import { source } from '@/lib/source';
import { type IndexEntry, type IndexSection, renderLlmsIndex } from './render-index';

export const revalidate = false;

const SUMMARY =
  'Alethia is a multi-cloud Kubernetes control plane: design infrastructure on a canvas or in alethia.yaml, review a verified plan, and apply it to AWS, GCP, Azure or Hetzner through a runner. These docs cover the console, the alethia CLI, the runner and self-hosting.';

/** The index entry for one page node, read from the page's own frontmatter. */
function entryFor(node: Item): IndexEntry | null {
  const page = source.getNodePage(node);
  if (!page) return null;
  return { title: page.data.title, url: page.url, description: page.data.description ?? '' };
}

/** Every page under `nodes`, depth first, in navigation order (a folder's index page first). */
function collectEntries(nodes: Node[]): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const node of nodes) {
    if (node.type === 'separator') continue;
    if (node.type === 'page') {
      const entry = entryFor(node);
      if (entry) out.push(entry);
      continue;
    }
    if (node.index) {
      const entry = entryFor(node.index);
      if (entry) out.push(entry);
    }
    out.push(...collectEntries(node.children));
  }
  return out;
}

/** A folder's title: its meta.json title, else its index page's title, else its tree name. */
function folderTitle(folder: Folder): string {
  const meta = source.getNodeMeta(folder);
  if (meta?.data.title) return meta.data.title;
  const index = folder.index ? source.getNodePage(folder.index) : undefined;
  if (index) return index.data.title;
  return typeof folder.name === 'string' ? folder.name : 'Pages';
}

/** Groups the page tree into the site's top-level sections; top-level pages form "Overview". */
function sections(): IndexSection[] {
  const tree = source.getPageTree();
  const overview: IndexSection = { title: 'Overview', entries: [] };
  const out: IndexSection[] = [overview];
  for (const node of tree.children) {
    if (node.type === 'folder') {
      out.push({ title: folderTitle(node), entries: collectEntries([node]) });
    } else {
      overview.entries.push(...collectEntries([node]));
    }
  }
  return out;
}

/** Serves `/docs/llms.txt`: instructions for agents, then an index of every page's Markdown URL. */
export function GET() {
  return new Response(renderLlmsIndex(SUMMARY, sections()), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
