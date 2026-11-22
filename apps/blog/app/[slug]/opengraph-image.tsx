// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { coverScene, coverSvg } from "@repo/brand/cover";
import { BRAND_BLACK, BRAND_INK, RAMP } from "@repo/brand/ramp-srgb";
import { ImageResponse } from "next/og";
import { KIND_LABELS, newsDate } from "@/lib/news";
import { getPost, getPublishedPosts } from "@/lib/posts";

export const alt = "Alethia News";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export function generateStaticParams() {
	return getPublishedPosts().map((post) => ({ slug: post.slug }));
}

/**
 * The social card for one post: the post's own generated cover art (the same scene the page
 * draws, in the dark theme's literal colours), with the kind, date and title on a solid panel on
 * the left (no gradient: the brand has none). Always the generated art, even for a post with a real cover image, so every card reads
 * as one family.
 */
export default async function OpengraphImage(props: { params: Promise<{ slug: string }> }) {
	const { slug } = await props.params;
	const post = getPost(slug);
	const kind = post?.kind ?? "engineering";
	const art = coverSvg(coverScene(slug, kind, "og"), { background: RAMP.gray1100, ink: BRAND_INK });

	return new ImageResponse(
		(
			<div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: BRAND_BLACK, fontFamily: "sans-serif" }}>
				<img src={`data:image/svg+xml;utf8,${encodeURIComponent(art)}`} width={1200} height={630} alt="" style={{ position: "absolute", inset: 0 }} />
				<div
					style={{
						position: "absolute",
						left: 0,
						top: 0,
						bottom: 0,
						width: 720,
						display: "flex",
						flexDirection: "column",
						justifyContent: "flex-end",
						padding: 64,
						gap: 20,
						background: BRAND_BLACK,
						borderRight: `2px solid ${RAMP.gray900}`,
						color: BRAND_INK,
					}}
				>
					<div style={{ display: "flex", fontSize: 22, letterSpacing: 3, textTransform: "uppercase", color: RAMP.gray400 }}>
						{post ? `${KIND_LABELS[post.kind]} · ${newsDate(post.date)}` : "Alethia News"}
					</div>
					<div style={{ display: "flex", fontSize: 54, fontWeight: 700, lineHeight: 1.1, letterSpacing: -1.5 }}>{post?.title ?? "Alethia News"}</div>
					<div style={{ display: "flex", fontSize: 22, color: RAMP.gray500 }}>alethialabs.io/news</div>
				</div>
			</div>
		),
		size,
	);
}
