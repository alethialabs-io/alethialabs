// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { disp, eyebrow, mono, Wrap } from "@repo/brand/site-primitives";
import { cloudListLabel } from "@repo/cloud-catalog";
import { formatDate } from "@repo/format";
import { Badge } from "@repo/ui/badge";
import { NewsCover } from "@repo/brand/cover";
import { RELEASES_URL, type PostItem, type ReleaseItem } from "@repo/brand/news-feeds";

/**
 * The home page, editorial: one statement, the film, the latest releases, four posts. Nothing
 * else — the header carries the actions and the footer carries the rest of the site.
 *
 * Every section here is a server component with no client JavaScript. The feed sections render
 * nothing when their feed is empty (GitHub or News unreachable), so the page degrades to
 * statement + film instead of showing an error.
 */

/** Dates are pinned to UTC so a server render and a client hydration can never disagree. */
function day(iso: string): string {
	return formatDate(iso, "date", "UTC");
}

/**
 * The Beta line above the statement (REL-L17, #7100): the product is in beta with no uptime SLA,
 * on the clouds the catalog offers — a hidden cloud drops out by itself. No launch date, because
 * the date can still move (decision M15, 2026-11-17).
 */
function BetaLine() {
	return (
		<a
			href="/docs/get-started"
			className="mb-6 inline-flex flex-wrap items-center gap-2 text-ui-xs text-text-tertiary no-underline transition-colors hover:text-text-secondary"
		>
			<Badge variant="outline" className="vx-badge-mono px-1.5 py-px">
				Beta
			</Badge>
			{`On ${cloudListLabel()}. No uptime SLA during the beta.`}
			<span className="text-text-disabled">Get started ›</span>
		</a>
	);
}

/** The opening statement: the Beta line, then a bold lead sentence and a quieter continuation. */
export function Statement() {
	return (
		<section className="pt-[72px] pb-12 max-[640px]:pt-12 max-[640px]:pb-8">
			<Wrap>
				<BetaLine />
				<h1
					className="text-display-md"
					style={{ ...disp, margin: 0, maxWidth: "48ch", lineHeight: 1.14, letterSpacing: "var(--tracking-display)", color: "var(--text-primary)", fontWeight: 400, textWrap: "balance" }}
				>
					<span style={{ fontWeight: 600 }}>Alethia provisions Kubernetes into your own cloud and proves every change.</span>{" "}
					Keyless on AWS, GCP and Azure, with a signed receipt for every apply that you can check without us.
				</h1>
			</Wrap>
		</section>
	);
}

/**
 * The film panel. Until the film is published it shows its poster frame, a still from the
 * code-built film, with no play control — a play button that plays nothing would be a lie.
 * Pass `src` once the film exists and the panel becomes a player.
 */
export function Film({ src }: { src?: string }) {
	const poster = "/mkt-assets/home/film-poster.jpg";
	return (
		<section className="pb-16 max-[640px]:pb-10">
			<div className="mx-auto w-full max-w-[1320px] px-4 min-[1360px]:px-0">
				<div
					className="relative overflow-hidden"
					style={{ aspectRatio: "2 / 1", border: "1px solid var(--border)", background: "var(--surface-sunken)" }}
				>
					{src ? (
						<video
							src={src}
							poster={poster}
							controls
							playsInline
							preload="metadata"
							aria-label="The Alethia film"
							style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
						/>
					) : (
						// A rendered still from the film, not a photograph: decorative, so it carries no alt text.
						// eslint-disable-next-line @next/next/no-img-element -- /_next/image is not routed to this app at the edge
						<img src={poster} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
					)}
				</div>
			</div>
		</section>
	);
}

/** A thin row inside a card: a label and an arrow, the whole row a link. */
function CardRow({ label, href, external }: { label: string; href: string; external?: boolean }) {
	return (
		<a
			href={href}
			target={external ? "_blank" : undefined}
			rel={external ? "noreferrer" : undefined}
			className="flex items-center justify-between py-3 text-text-secondary transition-colors hover:text-text-primary"
			style={{ borderTop: "1px solid var(--border-faint)", textDecoration: "none", fontSize: 14 }}
		>
			<span>{label}</span>
			<span aria-hidden="true">→</span>
		</a>
	);
}

/** The latest releases, three cards in a row: what shipped, when, and the first change it lists. */
export function Latest({ releases }: { releases: ReleaseItem[] }) {
	if (releases.length === 0) return null;
	return (
		<section className="pb-20 max-[640px]:pb-12">
			<Wrap>
				<div className="grid grid-cols-1 gap-3 md:grid-cols-3">
					{releases.map((r) => (
						<article
							key={r.url}
							className="flex flex-col"
							style={{ border: "1px solid var(--border)", background: "var(--surface)", padding: "20px 20px 18px", minWidth: 0 }}
						>
							<div className="flex items-center gap-3" style={{ ...eyebrow, fontSize: 10.5 }}>
								<span style={{ border: "1px solid var(--border-strong)", padding: "2px 7px", color: "var(--text-secondary)" }}>Release</span>
								<span>{day(r.date)}</span>
							</div>
							<h2 style={{ ...disp, fontSize: 22, fontWeight: 600, letterSpacing: "var(--tracking-display)", lineHeight: 1.15, margin: "16px 0 8px", color: "var(--text-primary)" }}>
								{r.title}
							</h2>
							<p className="text-text-secondary" style={{ fontSize: 14, lineHeight: 1.55, margin: 0, flex: 1 }}>
								{r.summary || "Maintenance release."}
							</p>
							<div style={{ marginTop: 20 }}>
								<CardRow label="Release notes" href={r.url} external />
								<CardRow label="Every release" href={RELEASES_URL} external />
							</div>
						</article>
					))}
				</div>
			</Wrap>
		</section>
	);
}

/**
 * The four newest News posts, each a generated grayscale cover (@repo/brand/cover, the same art
 * News draws for the post), a date and a title.
 */
export function FromNews({ posts }: { posts: PostItem[] }) {
	if (posts.length === 0) return null;
	return (
		<section className="pb-24 max-[640px]:pb-14">
			<Wrap>
				<div className="flex items-baseline justify-between" style={{ borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", padding: "12px 0", marginBottom: 20 }}>
					<h2 style={{ ...disp, fontSize: 15, fontWeight: 600, margin: 0, color: "var(--text-primary)" }}>From News</h2>
					<a href="/news" className="text-text-secondary hover:text-text-primary" style={{ fontSize: 13.5, textDecoration: "none" }}>
						All news →
					</a>
				</div>
				<div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
					{posts.map((p) => (
						<a key={p.url} href={p.url} className="group flex flex-col gap-3" style={{ textDecoration: "none", minWidth: 0 }}>
							<div className="aspect-[4/3]" style={{ border: "1px solid var(--border)", overflow: "hidden" }}>
								<NewsCover slug={p.slug} kind={p.kind} aspect="card" />
							</div>
							<span style={{ ...mono, ...eyebrow, fontSize: 10.5 }}>{day(p.date)}</span>
							<span className="text-text-primary group-hover:underline" style={{ ...disp, fontSize: 17, fontWeight: 600, lineHeight: 1.25, letterSpacing: "var(--tracking-display)", textUnderlineOffset: 4 }}>
								{p.title}
							</span>
						</a>
					))}
				</div>
			</Wrap>
		</section>
	);
}
