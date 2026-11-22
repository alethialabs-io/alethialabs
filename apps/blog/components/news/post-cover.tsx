// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Image from "next/image";
import { NewsCover, type CoverAspect } from "@repo/brand/cover";
import { coverSrc } from "@/lib/news";
import type { Post } from "@/lib/posts";

/** The box per frame; the art or the image fills it, cropped to the centre. */
const FRAME: Record<Exclude<CoverAspect, "og">, string> = {
	hero: "aspect-video",
	card: "aspect-[4/3]",
};

/**
 * A post's cover. A real image (`cover:` in the frontmatter) is rendered GRAYSCALE — the brand
 * allows photos only without colour; without one, the post gets generated grayscale art seeded
 * from its slug and kind. Either way the cover is decorative: the title beside it carries the
 * meaning, so the image has an empty alt and the art is aria-hidden.
 */
export function PostCover({
	post,
	aspect,
	priority = false,
	sizes,
}: {
	post: Pick<Post, "slug" | "kind" | "cover">;
	aspect: Exclude<CoverAspect, "og">;
	priority?: boolean;
	sizes: string;
}) {
	const src = coverSrc(post.cover);
	return (
		<div className={`relative overflow-hidden border border-border bg-surface-sunken ${FRAME[aspect]}`}>
			{src ? (
				<Image src={src} alt="" fill priority={priority} sizes={sizes} className="object-cover grayscale" />
			) : (
				<NewsCover slug={post.slug} kind={post.kind} aspect={aspect} />
			)}
		</div>
	);
}
