// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where public media is served from: https://assets.alethialabs.io, an R2 bucket owned by
 * infra/assets-cdn. Overridable per deployment with NEXT_PUBLIC_ASSETS_URL (a self-hoster's own
 * bucket, or a staging copy). Read once, without a trailing slash, so `assetUrl` can join on "/".
 *
 * Nothing links here yet: the bucket exists only once the maintainer applies the stack
 * (infra/assets-cdn/README.md). Until then, keep serving from /mkt-assets.
 */
export const ASSETS_URL = (process.env.NEXT_PUBLIC_ASSETS_URL ?? "https://assets.alethialabs.io").replace(/\/+$/, "");

/**
 * Absolute URL for an object in the public assets bucket. `path` is the object key, with or without
 * a leading slash — `assetUrl("media/films/home-v1.mp4")` and `assetUrl("/media/films/home-v1.mp4")`
 * are the same URL. Keys under /brand, /media and /people are cached for a year, so they must carry
 * a version or content hash in the filename (infra/assets-cdn/README.md, "Path convention").
 */
export function assetUrl(path: string): string {
	return `${ASSETS_URL}/${path.replace(/^\/+/, "")}`;
}
