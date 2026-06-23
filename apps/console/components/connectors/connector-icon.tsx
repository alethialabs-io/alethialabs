"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Image from "next/image";
import { useState } from "react";

/**
 * Renders a connector's icon, falling back to a clean monogram tile if the image
 * is missing or fails to load (e.g. a cloud whose logo hasn't been added to
 * public/<slug>/ yet). Keeps the connectors UI from breaking on a 404.
 */
export function ConnectorIcon({
	src,
	name,
	size = 28,
}: {
	src?: string | null;
	name: string;
	size?: number;
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
			className="object-contain"
			onError={() => setErrored(true)}
		/>
	);
}
