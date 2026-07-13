"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** Debounced search box that drives the org list via the `?q=` param (server-side filtering). */
export function OrgSearch({ initialQuery }: { initialQuery: string }) {
	const router = useRouter();
	const [value, setValue] = useState(initialQuery);

	useEffect(() => {
		const t = setTimeout(() => {
			const params = new URLSearchParams();
			if (value.trim()) params.set("q", value.trim());
			router.replace(`/orgs${params.toString() ? `?${params}` : ""}`);
		}, 250);
		return () => clearTimeout(t);
	}, [value, router]);

	return (
		<input
			type="search"
			value={value}
			onChange={(e) => setValue(e.target.value)}
			placeholder="Search by name, slug, or owner email…"
			className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
		/>
	);
}
