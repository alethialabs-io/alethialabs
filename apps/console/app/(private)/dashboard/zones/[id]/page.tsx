"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useParams } from "next/navigation";
import { ZoneDetailView } from "@/components/zones/zone-detail-view";

/** Legacy UUID zone route — renders the shared view. C2's slug route
 * (`/{org}/{zone}`) renders the same view by resolved id. */
export default function ZoneDetailPage() {
	const { id } = useParams<{ id: string }>();
	return <ZoneDetailView zoneId={id} />;
}
