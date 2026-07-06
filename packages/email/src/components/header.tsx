// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Link, Section } from "@react-email/components";
import { Mark } from "./mark";
import { colors, fonts } from "./theme";

/** Shared email header — centered [·] mark + "Alethia Labs" lockup. */
export function EmailHeader() {
	return (
		<Section
			className="a-border"
			style={{
				padding: "30px 40px 26px",
				borderBottom: `1px solid ${colors.border}`,
				textAlign: "center",
			}}
		>
			<Link
				href="https://alethialabs.io"
				className="a-text"
				style={{ textDecoration: "none", color: colors.textPrimary }}
			>
				<Mark size={22} />
				<span
					className="a-text"
					style={{
						fontFamily: fonts.sans,
						fontSize: "19px",
						fontWeight: 600,
						letterSpacing: "-0.01em",
						verticalAlign: "middle",
						marginLeft: "9px",
					}}
				>
					Alethia
				</span>
				<span
					className="a-text-3"
					style={{
						fontFamily: fonts.mono,
						fontSize: "9px",
						letterSpacing: "0.26em",
						textTransform: "uppercase",
						color: colors.textTertiary,
						verticalAlign: "middle",
						marginLeft: "6px",
					}}
				>
					Labs
				</span>
			</Link>
		</Section>
	);
}
