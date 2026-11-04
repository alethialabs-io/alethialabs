"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { defaultRehypePlugins, Streamdown } from "streamdown";

/** One entry of streamdown's default rehype chain: a plugin, or a plugin with its settings. */
type RehypeEntry = (typeof defaultRehypePlugins)[string];

/**
 * streamdown's `harden` entry, with blocked links and images rendered as their plain text —
 * not streamdown's default indicator, which appends "[blocked]" and a "Blocked URL" tooltip.
 * The plugin and its other settings are streamdown's own; only the two block policies change.
 */
function withTextOnlyBlocks(entry: RehypeEntry): RehypeEntry {
  if (!Array.isArray(entry)) return entry;
  const [plugin, settings] = entry;
  const base = typeof settings === "object" && settings !== null ? settings : {};
  return [
    plugin,
    { ...base, linkBlockPolicy: "text-only", imageBlockPolicy: "text-only" },
  ];
}

/**
 * Release notes are read from `runner_releases`, which the release pipeline writes through
 * `/api/releases/runner`; the console does not author them, so they are rendered as untrusted
 * markdown:
 * - raw HTML is OFF: `rehype-raw` is left out of streamdown's default chain, so an HTML node never
 *   becomes an element and shows as literal text — what react-markdown, which this replaced, did;
 * - a `javascript:` link renders as inert text. Two layers each drop it on their own:
 *   `rehype-sanitize` (streamdown's schema keeps only http(s)/irc/mailto/xmpp/tel hrefs, plus
 *   its own internal `streamdown:`) and `rehype-harden`, which also stamps
 *   `rel="noopener noreferrer"` on the links it keeps;
 * - images keep only `http(s)` sources. A `data:` or `javascript:` image becomes its alt text.
 *   `rehype-sanitize` is the layer that does this for `data:`: streamdown's `harden` settings allow
 *   data images, so dropping `sanitize` would let one through;
 * - blocked links and images render as plain text (`withTextOnlyBlocks` above);
 * - link safety is off: a link stays a plain `<a>`, as under react-markdown, rather than the
 *   chat's button-plus-confirm-modal. Unlike react-markdown, it now opens in a new tab.
 */
const releaseNotesRehypePlugins = [
  defaultRehypePlugins.sanitize,
  withTextOnlyBlocks(defaultRehypePlugins.harden),
];

/**
 * Streamdown's own heading and code sizes (`text-3xl` … `text-sm`) are chat-sized. These
 * descendant rules out-rank them (a class plus a descendant selector beats a lone class) and put
 * every element on the shared `--text-ui-*` rungs: headings at body size or one rung up, as the
 * popover typeset its `h2`/`h3` before, with tight list spacing.
 */
const releaseNotesClassName = [
  "min-w-0 space-y-2 break-words text-ui-md",
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  "[&_h1]:mt-3 [&_h1]:mb-1.5 [&_h1]:text-ui-lg",
  "[&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-ui-md",
  "[&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-ui-md",
  "[&_h4]:mt-2 [&_h4]:mb-1 [&_h4]:text-ui-sm",
  "[&_h5]:text-ui-sm [&_h6]:text-ui-sm [&_li]:py-0.5",
  // The console's Tailwind build has no `@source` for streamdown's dist, so the list classes
  // streamdown puts on its own elements (`list-disc`, `list-inside`) are never generated and
  // preflight's `list-style: none` wins. These are written here, in console source, so they are.
  "[&_ul]:list-inside [&_ul]:list-disc [&_ol]:list-inside [&_ol]:list-decimal",
  "[&_[data-streamdown=inline-code]]:text-ui-xs",
  "[&_[data-streamdown=code-block]]:my-2 [&_[data-streamdown=code-block-body]]:text-ui-xs",
].join(" ");

/** Renders a release's markdown notes through streamdown — the console's one markdown renderer. */
export function ReleaseNotesMarkdown({ markdown }: { markdown: string }) {
  return (
    <Streamdown
      mode="static"
      className={releaseNotesClassName}
      rehypePlugins={releaseNotesRehypePlugins}
      linkSafety={{ enabled: false }}
      controls={false}
      lineNumbers={false}
    >
      {markdown}
    </Streamdown>
  );
}
