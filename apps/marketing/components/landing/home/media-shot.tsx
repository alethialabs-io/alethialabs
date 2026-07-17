// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Image from "next/image";
import type { CSSProperties } from "react";

/**
 * Frames a REAL captured console screenshot in a minimal, squared app-window
 * chrome (hairline border, whisper shadow, three window dots). Every product
 * image on the page is an authentic capture of the running console — never a
 * mock — so this is the only "device frame" we use. Dark-theme stills live under
 * `/mkt-assets/home/dark/`.
 */
export function MediaShot({
	src,
	alt,
	priority = false,
	style,
}: {
	src: string;
	alt: string;
	priority?: boolean;
	style?: CSSProperties;
}) {
	return (
		<div
			style={{
				border: "1px solid var(--border)",
				background: "var(--surface)",
				boxShadow: "var(--shadow-lg)",
				overflow: "hidden",
				...style,
			}}
		>
			<div
				style={{
					display: "flex",
					gap: 6,
					padding: "10px 14px",
					borderBottom: "1px solid var(--border)",
					background: "var(--surface-muted)",
				}}
			>
				{[0, 1, 2].map((i) => (
					<span key={i} style={{ width: 9, height: 9, borderRadius: 999, border: "1px solid var(--border-strong)" }} />
				))}
			</div>
			<Image
				src={src}
				alt={alt}
				width={2200}
				height={1238}
				priority={priority}
				unoptimized
				sizes="(max-width: 1160px) 100vw, 1096px"
				style={{ display: "block", width: "100%", height: "auto" }}
			/>
		</div>
	);
}
