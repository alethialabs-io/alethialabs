// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { MetadataRoute } from "next";
import { brandRobots } from "@repo/brand/robots";
import { SITE_URL } from "@/lib/site";

/** robots.txt for the public marketing site (indexable; points at the sitemap). */
export default function robots(): MetadataRoute.Robots {
	return brandRobots(SITE_URL);
}
