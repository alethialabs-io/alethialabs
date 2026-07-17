"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useRef, useState } from "react";
import { mono, Prov, type ProviderId } from "./primitives";

interface Frame {
	cmd: string;
	out: string[];
}

const SESSION: Record<ProviderId, Frame[]> = {
	aws: [
		{ cmd: "alethia login", out: ["→ Opening browser for device authorization…", "✓ Authenticated · you@acme.cloud"] },
		{ cmd: "alethia project plan --cloud aws", out: ["▸ Compiling 11 sections → OpenTofu", "47 to add · 0 change · 0 destroy", "▸ Monthly estimate via Infracost", "✓ verify · 6 controls passed"] },
		{ cmd: "alethia project apply", out: ["✓ queued job · runner prod-eu-1", "✓ aws_eks_cluster.main     v1.31", "✓ helm_release.argocd      v2.12", "… +44 more", "✓ Apply complete · 12m 34s"] },
	],
	gcp: [
		{ cmd: "alethia login", out: ["→ Opening browser for device authorization…", "✓ Authenticated · you@acme.cloud"] },
		{ cmd: "alethia project plan --cloud gcp", out: ["▸ Compiling 11 sections → OpenTofu", "39 to add · 0 change · 0 destroy", "▸ Monthly estimate via Infracost", "✓ verify · 6 controls passed"] },
		{ cmd: "alethia project apply", out: ["✓ queued job · runner prod-eu-1", "✓ google_container_cluster.main", "✓ helm_release.argocd", "… +30 more", "✓ Apply complete · 9m 51s"] },
	],
	azure: [
		{ cmd: "alethia login", out: ["→ Opening browser for device authorization…", "✓ Authenticated · you@acme.cloud"] },
		{ cmd: "alethia project plan --cloud azure", out: ["▸ Compiling 11 sections → OpenTofu", "41 to add · 0 change · 0 destroy", "▸ Monthly estimate via Infracost", "✓ verify · 6 controls passed"] },
		{ cmd: "alethia project apply", out: ["✓ queued job · runner eu-2", "✓ azurerm_kubernetes_cluster", "✓ helm_release.argocd", "… +31 more", "✓ Apply complete · 11m 08s"] },
	],
};

const PROVIDERS: ProviderId[] = ["aws", "gcp", "azure"];

/** True when the user prefers reduced motion. */
function reduceMotion(): boolean {
	return (
		typeof window !== "undefined" &&
		window.matchMedia &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

/** Per-line color: results/totals brightest, prompts/notes dim. */
function lineTone(l: string): string {
	if (l.startsWith("✓") || l.includes("complete") || l.includes("$")) return "var(--text-primary)";
	if (l.startsWith("→") || l.startsWith("▸") || l.startsWith("…")) return "var(--text-tertiary)";
	return "var(--text-secondary)";
}

interface RenderedBlock {
	cmd: string;
	typed: number;
	out: string[];
}

/**
 * Animated CLI terminal — types each command, streams its output, then loops.
 * Switching provider (AWS/GCP/Azure) restarts the session for that cloud.
 */
export function LiveTerminal({ height = 360 }: { height?: number }) {
	const [prov, setProv] = useState<ProviderId>("aws");
	const [rendered, setRendered] = useState<RenderedBlock[]>([]);
	const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
	const provRef = useRef(prov);

	useEffect(() => {
		provRef.current = prov;
		timers.current.forEach(clearTimeout);
		timers.current = [];
		const frames = SESSION[prov];
		if (reduceMotion()) {
			setRendered(frames.map((f) => ({ cmd: f.cmd, typed: f.cmd.length, out: f.out.slice() })));
			return;
		}
		setRendered([]);
		const wait = (ms: number) =>
			new Promise<void>((res) => {
				const t = setTimeout(res, ms);
				timers.current.push(t);
			});
		void (async () => {
			const blocks: RenderedBlock[] = [];
			for (let fi = 0; fi < frames.length; fi++) {
				const f = frames[fi];
				blocks.push({ cmd: f.cmd, typed: 0, out: [] });
				const idx = blocks.length - 1;
				for (let c = 1; c <= f.cmd.length; c++) {
					if (provRef.current !== prov) return;
					blocks[idx] = { ...blocks[idx], typed: c };
					setRendered(blocks.map((b) => ({ ...b, out: b.out.slice() })));
					await wait(24 + (f.cmd[c - 1] === " " ? 28 : 0));
				}
				await wait(340);
				for (let oi = 0; oi < f.out.length; oi++) {
					if (provRef.current !== prov) return;
					blocks[idx].out.push(f.out[oi]);
					setRendered(blocks.map((b) => ({ ...b, out: b.out.slice() })));
					await wait(f.out[oi].startsWith("✓") ? 220 : 150);
				}
				await wait(fi === frames.length - 1 ? 2600 : 600);
			}
		})();
		return () => {
			timers.current.forEach(clearTimeout);
		};
	}, [prov]);

	useEffect(() => {
		const frames = SESSION[prov];
		const last = rendered[frames.length - 1];
		const done =
			rendered.length === frames.length &&
			last &&
			last.out.length === frames[frames.length - 1].out.length;
		if (done && !reduceMotion()) {
			const t = setTimeout(() => setRendered([]), 2800);
			return () => clearTimeout(t);
		}
	}, [rendered, prov]);

	return (
		<div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", overflow: "hidden", background: "var(--surface)", boxShadow: "var(--shadow-lg)" }}>
			<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 15px", borderBottom: "1px solid var(--border)", background: "var(--surface-muted)" }}>
				<div style={{ display: "flex", alignItems: "center", gap: 11 }}>
					<div style={{ display: "flex", gap: 6 }}>
						{[0, 1, 2].map((i) => (
							<span key={i} style={{ width: 10, height: 10, borderRadius: 999, border: "1px solid var(--border-strong)" }} />
						))}
					</div>
					<span style={{ ...mono, fontSize: 11, color: "var(--text-tertiary)", letterSpacing: "0.04em" }}>alethia — zsh</span>
				</div>
				<div style={{ display: "flex", gap: 4 }}>
					{PROVIDERS.map((p) => (
						<button
							key={p}
							type="button"
							onClick={() => setProv(p)}
							style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 9px", borderRadius: "var(--radius-sm)", border: "1px solid " + (prov === p ? "var(--border-strong)" : "transparent"), background: prov === p ? "var(--surface)" : "transparent", cursor: "pointer", fontSize: 11, color: prov === p ? "var(--text-primary)" : "var(--text-tertiary)", ...mono }}
						>
							<Prov id={p} size={13} />
							{p.toUpperCase()}
						</button>
					))}
				</div>
			</div>
			<pre style={{ margin: 0, padding: "20px 22px", ...mono, fontSize: 13, lineHeight: 1.85, color: "var(--text-secondary)", height, overflow: "hidden", whiteSpace: "pre-wrap", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
				{rendered.map((b, bi) => {
					const last = bi === rendered.length - 1;
					const typing = b.typed < b.cmd.length;
					return (
						<div key={bi} style={{ marginTop: bi ? 14 : 0 }}>
							<div style={{ color: "var(--text-primary)" }}>
								<span style={{ color: "var(--text-tertiary)" }}>$ </span>
								{b.cmd.slice(0, b.typed)}
								{last && typing && <span className="ah-caret" />}
							</div>
							{b.out.map((l, li) => (
								<div key={li} style={{ color: lineTone(l) }}>{"  " + l}</div>
							))}
							{last && !typing && <span className="ah-caret" style={{ marginLeft: 2 }} />}
						</div>
					);
				})}
			</pre>
		</div>
	);
}
