"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { type CSSProperties } from "react";
import { Badge } from "@repo/ui/badge";
import {
	type SignedReceipt,
	type VerifyStatus,
	SAMPLE_RECEIPT,
} from "@/lib/proof/verify-receipt-sample";
import { mono } from "./primitives";

/** Verdict/status → grayscale Badge variant (no color; fail is solid, pass is outline). */
function statusBadgeVariant(s: VerifyStatus): "default" | "outline" | "secondary" {
	if (s === "fail") return "default";
	if (s === "pass") return "outline";
	return "secondary";
}

const VERDICT_LABEL: Record<VerifyStatus, string> = {
	pass: "passed",
	fail: "blocked",
	warn: "warnings",
	not_evaluable: "not evaluable",
};

const card: CSSProperties = {
	width: "100%",
	maxWidth: 720,
	textAlign: "left",
	border: "1px solid var(--border-strong)",
	borderRadius: "var(--radius-2xl)",
	background: "var(--surface)",
	boxShadow: "var(--shadow-xl)",
	overflow: "hidden",
	position: "relative",
};

const foot: CSSProperties = {
	display: "flex",
	flexWrap: "wrap",
	gap: "8px 22px",
	padding: "15px 18px",
	borderTop: "1px solid var(--border)",
	background: "var(--surface-sunken)",
	...mono,
	fontSize: 11,
	color: "var(--text-tertiary)",
};

/**
 * The homepage "prove it" hero object: a faithful render of a REAL signed elench
 * verify receipt (the same shape the console shows in the agent Plan tab). Every
 * control id, framework, verdict, and the plan hash come from the actual engine —
 * see `lib/proof/verify-receipt-sample.ts`. Pure presentational; the receipt is
 * passed in (defaults to the engine-produced sample).
 */
export function VerifyReceipt({
	receipt = SAMPLE_RECEIPT,
}: {
	receipt?: SignedReceipt;
}) {
	const body = receipt.receipt;
	const report = body.report;
	const signed = receipt.algorithm === "ed25519";
	const total = report.controls.length;
	const keyless = report.controls.some(
		(c) => c.id === "KEYLESS-001" && c.status === "pass",
	);

	/** Download the raw signed receipt JSON — it verifies offline against the key. */
	const download = () => {
		const blob = new Blob([JSON.stringify(receipt, null, 2)], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `elench-receipt-${body.plan_sha256.slice(0, 8)}.json`;
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<div style={card}>
			{/* inner-ring highlight so the proof card "glows from within" in grayscale */}
			<span
				aria-hidden
				style={{
					position: "absolute",
					inset: 0,
					pointerEvents: "none",
					borderRadius: "inherit",
					boxShadow: "inset 0 1px 0 0 oklch(1 0 0 / 0.06)",
				}}
			/>
			{/* top bar */}
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					padding: "14px 18px",
					borderBottom: "1px solid var(--border)",
					background: "var(--surface-muted)",
				}}
			>
				<span style={{ display: "flex", alignItems: "center", gap: 12, ...mono, fontSize: 12, color: "var(--text-secondary)" }}>
					<span style={{ display: "flex", gap: 6 }}>
						{[0, 1, 2].map((i) => (
							<span key={i} style={{ width: 9, height: 9, borderRadius: 999, border: "1px solid var(--border-strong)" }} />
						))}
					</span>
					elench verify · {body.provider} ·{" "}
					<span style={{ color: "var(--text-tertiary)" }}>{body.catalog_version}</span>
				</span>
				<Badge variant={statusBadgeVariant(report.verdict)} className="rounded-none text-[9px] uppercase tracking-widest">
					{VERDICT_LABEL[report.verdict]}
				</Badge>
			</div>

			{/* control rows */}
			<div>
				{report.controls.map((c) => (
					<div
						key={c.id}
						style={{
							display: "grid",
							gridTemplateColumns: "128px 1fr auto",
							gap: 16,
							alignItems: "center",
							padding: "13px 18px",
							borderBottom: "1px solid var(--border-faint)",
						}}
					>
						<span style={{ ...mono, fontSize: 12, color: "var(--text-primary)" }}>{c.id}</span>
						<span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
							<Badge variant={statusBadgeVariant(c.status)} className="rounded-none text-[9px] uppercase">
								{c.status.replace("_", " ")}
							</Badge>
							<span style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>{c.title}</span>
						</span>
						<span style={{ ...mono, fontSize: 10.5, color: "var(--text-tertiary)", letterSpacing: "0.04em", textAlign: "right", whiteSpace: "nowrap" }}>
							{c.frameworks?.join(" · ") ?? ""}
						</span>
					</div>
				))}
			</div>

			{/* footer */}
			<div style={foot}>
				<span>
					<span style={{ color: "var(--text-secondary)" }}>{report.summary.pass}</span>/{total} controls passed
				</span>
				<span>
					{report.summary.fail} fail · {report.summary.warn} warn · {report.summary.not_evaluable} not-evaluable
				</span>
				{keyless && (
					<span>
						<span style={{ color: "var(--text-secondary)" }}>keys held:</span> 0
					</span>
				)}
				<span>
					plan <span style={{ color: "var(--text-secondary)" }}>sha256:{body.plan_sha256.slice(0, 4)}…{body.plan_sha256.slice(-4)}</span>
				</span>
				<span>
					{signed ? (
						<>
							signed · <span style={{ color: "var(--text-secondary)" }}>key {receipt.key_id}</span> · ed25519
						</>
					) : (
						"unsigned"
					)}
				</span>
				<button
					type="button"
					onClick={download}
					style={{
						marginLeft: "auto",
						...mono,
						fontSize: 10.5,
						letterSpacing: "0.06em",
						textTransform: "uppercase",
						color: "var(--text-tertiary)",
						background: "transparent",
						border: "1px solid var(--border)",
						borderRadius: 0,
						padding: "5px 11px",
						cursor: "pointer",
					}}
				>
					Download receipt.json
				</button>
			</div>
		</div>
	);
}
