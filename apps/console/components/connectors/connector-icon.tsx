"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@repo/ui/utils";
import Image from "next/image";
import { useState } from "react";

/**
 * Renders a connector's icon, falling back to a clean monogram tile if the image
 * is missing or fails to load (e.g. a cloud whose logo hasn't been added to
 * public/<slug>/ yet). Keeps the connectors UI from breaking on a 404. The logo
 * is grayscale by default (design system); pass `mono={false}` to show it in full
 * color — e.g. for a connected connector.
 */
export function ConnectorIcon({
	src,
	name,
	size = 28,
	mono = true,
}: {
	src?: string | null;
	name: string;
	size?: number;
	mono?: boolean;
}) {
	const [errored, setErrored] = useState(false);

	if (!src || errored) {
		return (
			<span
				className="font-semibold text-muted-foreground select-none"
				style={{ fontSize: Math.round(size * 0.5) }}
				aria-hidden
			>
				{name.charAt(0).toUpperCase()}
			</span>
		);
	}

	return (
		<Image
			src={src}
			alt={name}
			width={size}
			height={size}
			className={cn("object-contain", mono && "grayscale opacity-90")}
			onError={() => setErrored(true)}
		/>
	);
}
