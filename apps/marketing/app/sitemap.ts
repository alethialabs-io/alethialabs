// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { MetadataRoute } from "next";
import { brandSitemap } from "@repo/brand/sitemap";
import { SITE_URL, MARKETING_SITEMAP_PATHS } from "@/lib/site";

/** Sitemap for the public marketing pages. */
export default function sitemap(): MetadataRoute.Sitemap {
	return brandSitemap(SITE_URL, MARKETING_SITEMAP_PATHS, new Date());
}
