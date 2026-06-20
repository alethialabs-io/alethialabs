// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	Body,
	Container,
	Head,
	Html,
	Preview,
	Section,
} from "@react-email/components";
import type { ReactNode } from "react";
import { EmailFooter } from "./footer";
import { EmailHeader } from "./header";
import { colors, fonts } from "./theme";

interface EmailLayoutProps {
	/** Inbox preheader text. */
	preview: string;
	/** Per-email footer legal line. */
	legal: ReactNode;
	children: ReactNode;
}

/** Shared shell: light canvas, 600px card, shared header + footer. */
export function EmailLayout({ preview, legal, children }: EmailLayoutProps) {
	return (
		<Html lang="en">
			<Head>
				<meta name="color-scheme" content="light" />
				<meta name="supported-color-schemes" content="light" />
			</Head>
			<Preview>{preview}</Preview>
			<Body
				className="a-canvas"
				style={{
					margin: 0,
					backgroundColor: colors.canvas,
					fontFamily: fonts.sans,
				}}
			>
				<Container
					className="a-surface"
					style={{
						maxWidth: "600px",
						margin: "0 auto",
						backgroundColor: colors.surface,
					}}
				>
					<EmailHeader />
					<Section style={{ padding: "40px 40px 36px" }}>
						{children}
					</Section>
					<EmailFooter legal={legal} />
				</Container>
			</Body>
		</Html>
	);
}
