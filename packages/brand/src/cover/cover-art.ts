// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Generated cover art for News: a deterministic, grayscale drawing on the 44px blueprint grid,
 * seeded from a post's slug and kind. The same slug always draws the same picture, two slugs
 * almost never draw the same one, and no photograph or external asset is involved.
 *
 * This file is PURE: it computes a scene (a list of primitives in one viewBox) and can render it
 * as an SVG string with literal colours, for an OG image. `NewsCover` (news-cover.tsx) renders the
 * same scene as React with CSS variables, so the page version follows the light/dark theme.
 */

/** The three frames a cover is drawn for. */
export type CoverAspect = "hero" | "card" | "og";

/** The viewBox per frame: 16:9 for a post hero, 4:3 for a card, 1200×630 for a social image. */
export const COVER_SIZES: Record<CoverAspect, { width: number; height: number }> = {
	hero: { width: 1584, height: 891 },
	card: { width: 1188, height: 891 },
	og: { width: 1200, height: 630 },
};

/** The blueprint grid step, in viewBox units — the brand's 44px motif. */
export const GRID = 44;

/** The motif families. Each is a different drawing, not a variation of one. */
export const MOTIFS = ["contours", "blocks", "graph", "bars", "brackets", "field"] as const;
export type Motif = (typeof MOTIFS)[number];

/**
 * Which families suit which kind of post. A kind narrows the choice; the slug picks within it.
 * Every family appears under at least two kinds, so no motif is reserved to one tier.
 */
const KIND_MOTIFS: Record<string, readonly Motif[]> = {
	announcement: ["brackets", "contours", "field", "blocks"],
	product: ["blocks", "field", "brackets", "graph"],
	engineering: ["graph", "blocks", "contours", "bars"],
	changelog: ["bars", "graph", "field"],
	company: ["field", "contours", "brackets"],
};

/** Ink tiers a primitive is drawn in. `ink` is the text colour, `bg` the cover's own fill. */
export type CoverPaint = "ink" | "bg" | "none";

/** One drawn primitive. Coordinates are viewBox units; opacity is 0–1 over the cover fill. */
export type CoverShape =
	| { type: "path"; d: string; stroke: number; opacity: number; fill: CoverPaint; fillOpacity?: number }
	| { type: "circle"; cx: number; cy: number; r: number; opacity: number; fill: CoverPaint; stroke?: number };

/** A whole cover: its frame, the motif that drew it, and the primitives in paint order. */
export interface CoverScene {
	width: number;
	height: number;
	motif: Motif;
	shapes: CoverShape[];
}

/** FNV-1a over the string's UTF-16 units: a stable 32-bit seed with no dependency. */
export function hashSeed(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** mulberry32: a tiny seeded PRNG returning floats in [0, 1). */
export function seededRandom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The motif a slug and kind draw. Exposed so a test can show the families are all reachable. */
export function pickMotif(slug: string, kind: string): Motif {
	const choices = KIND_MOTIFS[kind] ?? MOTIFS;
	return choices[hashSeed(`motif:${kind}:${slug}`) % choices.length] ?? "field";
}

/** Rounds to one decimal so the SVG text stays short and byte-stable across engines. */
function n(value: number): number {
	return Math.round(value * 10) / 10;
}

type Rand = () => number;

/** A random value in [lo, hi). */
function between(rand: Rand, lo: number, hi: number): number {
	return lo + rand() * (hi - lo);
}

/** A random integer in [lo, hi]. */
function int(rand: Rand, lo: number, hi: number): number {
	return Math.floor(between(rand, lo, hi + 1));
}

/** Snaps a coordinate to the blueprint grid. */
function snap(value: number): number {
	return Math.round(value / GRID) * GRID;
}

/** The background grid: hairlines every GRID units, both directions, as one path. */
function gridShape(width: number, height: number): CoverShape {
	const parts: string[] = [];
	for (let x = GRID; x < width; x += GRID) parts.push(`M${x} 0V${height}`);
	for (let y = GRID; y < height; y += GRID) parts.push(`M0 ${y}H${width}`);
	return { type: "path", d: parts.join(""), stroke: 2, opacity: 0.1, fill: "none" };
}

/** Topographic contours: closed rings around a centre, each warped by a few low harmonics. */
function contours(rand: Rand, w: number, h: number): CoverShape[] {
	const cx = between(rand, w * 0.3, w * 0.7);
	const cy = between(rand, h * 0.3, h * 0.7);
	const rings = int(rand, 9, 15);
	const harmonics = Array.from({ length: 3 }, (_, i) => ({ k: i + 2, phase: between(rand, 0, Math.PI * 2), amp: between(rand, 0.03, 0.11) }));
	const maxR = Math.hypot(w, h) * 0.55;
	const shapes: CoverShape[] = [];
	for (let i = 0; i < rings; i++) {
		const base = maxR * ((i + 1) / rings);
		const pts: string[] = [];
		for (let s = 0; s < 72; s++) {
			const a = (s / 72) * Math.PI * 2;
			const warp = harmonics.reduce((sum, hm) => sum + hm.amp * Math.sin(hm.k * a + hm.phase + i * 0.35), 0);
			const r = base * (1 + warp);
			pts.push(`${s === 0 ? "M" : "L"}${n(cx + r * Math.cos(a))} ${n(cy + r * Math.sin(a) * 0.8)}`);
		}
		shapes.push({ type: "path", d: `${pts.join("")}Z`, stroke: 2.8, opacity: 0.75 - (0.55 * i) / rings, fill: "none" });
	}
	shapes.push({ type: "circle", cx: n(cx), cy: n(cy), r: 6, opacity: 0.9, fill: "ink" });
	return shapes;
}

/** Isometric blocks: a grid of boxes with seeded heights, painted back to front. */
function blocks(rand: Rand, w: number, h: number): CoverShape[] {
	const unit = GRID * 1.5;
	const cols = int(rand, 4, 6);
	const rows = int(rand, 3, 5);
	const ox = w / 2;
	const oy = h * 0.42 - ((cols + rows) * unit * 0.25) / 2;
	const shapes: CoverShape[] = [];
	const accent = int(rand, 0, cols * rows - 1);
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			if (rand() < 0.18) continue;
			const height = unit * between(rand, 0.3, 2.6);
			const x = ox + (c - r) * unit * 0.87;
			const y = oy + (c + r) * unit * 0.5;
			const dx = unit * 0.87;
			const dy = unit * 0.5;
			const top = `M${n(x)} ${n(y - height)}L${n(x + dx)} ${n(y + dy - height)}L${n(x)} ${n(y + 2 * dy - height)}L${n(x - dx)} ${n(y + dy - height)}Z`;
			const left = `M${n(x - dx)} ${n(y + dy - height)}L${n(x)} ${n(y + 2 * dy - height)}L${n(x)} ${n(y + 2 * dy)}L${n(x - dx)} ${n(y + dy)}Z`;
			const right = `M${n(x + dx)} ${n(y + dy - height)}L${n(x)} ${n(y + 2 * dy - height)}L${n(x)} ${n(y + 2 * dy)}L${n(x + dx)} ${n(y + dy)}Z`;
			const lit = r * cols + c === accent;
			shapes.push({ type: "path", d: left, stroke: 2.4, opacity: 0.55, fill: "bg" });
			shapes.push({ type: "path", d: right, stroke: 2.4, opacity: 0.55, fill: "ink", fillOpacity: 0.06 });
			shapes.push({ type: "path", d: top, stroke: 2.4, opacity: 0.8, fill: lit ? "ink" : "bg", fillOpacity: lit ? 0.85 : 1 });
		}
	}
	return shapes;
}

/** A node graph: grid-snapped nodes joined to their nearest neighbours by orthogonal runs. */
function graph(rand: Rand, w: number, h: number): CoverShape[] {
	const count = int(rand, 12, 20);
	const nodes: { x: number; y: number }[] = [];
	for (let i = 0; i < count * 3 && nodes.length < count; i++) {
		const x = snap(between(rand, w * 0.08, w * 0.92));
		const y = snap(between(rand, h * 0.12, h * 0.88));
		if (!nodes.some((p) => p.x === x && p.y === y)) nodes.push({ x, y });
	}
	const edges: string[] = [];
	const seen = new Set<string>();
	nodes.forEach((p, i) => {
		const nearest = nodes
			.map((q, j) => ({ j, d: Math.hypot(p.x - q.x, p.y - q.y) }))
			.filter((e) => e.j !== i)
			.sort((a, b) => a.d - b.d)
			.slice(0, 2);
		for (const { j } of nearest) {
			const key = i < j ? `${i}-${j}` : `${j}-${i}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const q = nodes[j];
			if (!q) continue;
			edges.push(rand() < 0.5 ? `M${p.x} ${p.y}H${q.x}V${q.y}` : `M${p.x} ${p.y}V${q.y}H${q.x}`);
		}
	});
	const hub = int(rand, 0, nodes.length - 1);
	const shapes: CoverShape[] = [{ type: "path", d: edges.join(""), stroke: 2.8, opacity: 0.45, fill: "none" }];
	nodes.forEach((p, i) => {
		const s = i === hub ? 14 : 8;
		shapes.push({
			type: "path",
			d: `M${p.x - s} ${p.y - s}h${2 * s}v${2 * s}h${-2 * s}Z`,
			stroke: 2.8,
			opacity: 0.85,
			fill: i === hub ? "ink" : "bg",
			fillOpacity: i === hub ? 0.9 : 1,
		});
	});
	return shapes;
}

/** Bars under a waveform: a release-shaped rhythm of columns and one continuous line above. */
function bars(rand: Rand, w: number, h: number): CoverShape[] {
	const count = Math.floor((w * 0.84) / (GRID / 2));
	const x0 = (w - count * (GRID / 2)) / 2;
	const base = h * 0.82;
	const waves = Array.from({ length: 3 }, () => ({ f: between(rand, 0.5, 3.2), phase: between(rand, 0, Math.PI * 2), amp: between(rand, 0.2, 0.5) }));
	const value = (t: number) => waves.reduce((sum, wv) => sum + wv.amp * Math.sin(wv.f * t * Math.PI * 2 + wv.phase), 0);
	const parts: string[] = [];
	const line: string[] = [];
	const peak = int(rand, 0, count - 1);
	let peakBar = "";
	for (let i = 0; i < count; i++) {
		const t = i / count;
		const v = 0.5 + value(t) * 0.5 + between(rand, -0.08, 0.08);
		const height = Math.max(GRID * 0.2, Math.min(h * 0.55, v * h * 0.42));
		const x = n(x0 + i * (GRID / 2) + GRID / 4);
		const bar = `M${x} ${n(base)}V${n(base - height)}`;
		if (i === peak) peakBar = bar;
		else parts.push(bar);
		line.push(`${i === 0 ? "M" : "L"}${x} ${n(base - height - GRID * 1.2 - value(t + 0.13) * GRID)}`);
	}
	return [
		{ type: "path", d: `M${n(x0)} ${n(base)}H${n(w - x0)}`, stroke: 2.8, opacity: 0.6, fill: "none" },
		{ type: "path", d: parts.join(""), stroke: GRID / 5, opacity: 0.32, fill: "none" },
		{ type: "path", d: peakBar, stroke: GRID / 5, opacity: 0.9, fill: "none" },
		{ type: "path", d: line.join(""), stroke: 3.2, opacity: 0.7, fill: "none" },
	];
}

/** Concentric brackets: the [·] mark, opened outward into nested square brackets. */
function brackets(rand: Rand, w: number, h: number): CoverShape[] {
	const cx = snap(between(rand, w * 0.35, w * 0.65));
	const cy = snap(h / 2);
	const count = int(rand, 4, 7);
	const step = GRID * between(rand, 0.8, 1.3);
	const arm = GRID * between(rand, 0.35, 0.7);
	const shapes: CoverShape[] = [];
	for (let i = 1; i <= count; i++) {
		const hw = step * i * 1.15;
		const hh = step * i * 0.75;
		const d = `M${n(cx - hw + arm)} ${n(cy - hh)}H${n(cx - hw)}V${n(cy + hh)}H${n(cx - hw + arm)}M${n(cx + hw - arm)} ${n(cy - hh)}H${n(cx + hw)}V${n(cy + hh)}H${n(cx + hw - arm)}`;
		shapes.push({ type: "path", d, stroke: i === 1 ? 9 : 3.5, opacity: 0.95 - (0.75 * (i - 1)) / count, fill: "none" });
	}
	shapes.push({ type: "circle", cx, cy, r: step * 0.22, opacity: 0.95, fill: "ink" });
	return shapes;
}

/** A dot field on the grid lattice, sized by a seeded radial falloff, with a few lit points. */
function field(rand: Rand, w: number, h: number): CoverShape[] {
	const fx = between(rand, w * 0.2, w * 0.8);
	const fy = between(rand, h * 0.2, h * 0.8);
	const spread = Math.hypot(w, h) * between(rand, 0.25, 0.45);
	const shapes: CoverShape[] = [];
	for (let x = GRID / 2; x < w; x += GRID / 2) {
		for (let y = GRID / 2; y < h; y += GRID / 2) {
			const d = Math.hypot(x - fx, y - fy) / spread;
			const strength = Math.max(0, 1 - d);
			if (strength <= 0.02) continue;
			shapes.push({ type: "circle", cx: x, cy: y, r: n(1 + strength * 4), opacity: n(0.15 + strength * 0.6), fill: "ink" });
		}
	}
	const lit = int(rand, 3, 6);
	for (let i = 0; i < lit; i++) {
		shapes.push({ type: "circle", cx: snap(between(rand, 0, w)), cy: snap(between(rand, 0, h)), r: 9, opacity: 0.9, fill: "bg", stroke: 3.5 });
	}
	return shapes;
}

const DRAW: Record<Motif, (rand: Rand, w: number, h: number) => CoverShape[]> = { contours, blocks, graph, bars, brackets, field };

/**
 * The cover scene for a post. Deterministic in `(slug, kind, aspect)`; the motif depends only on
 * the slug and kind, so a post keeps its family across the hero, the card and the OG image.
 */
export function coverScene(slug: string, kind: string, aspect: CoverAspect = "card"): CoverScene {
	const { width, height } = COVER_SIZES[aspect];
	const motif = pickMotif(slug, kind);
	const rand = seededRandom(hashSeed(`${kind}:${slug}:${aspect}`));
	return { width, height, motif, shapes: [gridShape(width, height), ...DRAW[motif](rand, width, height)] };
}

/** Literal colours for a string render, where CSS variables do not exist (an OG image). */
export interface CoverColors {
	background: string;
	ink: string;
}

/** Renders a scene as a standalone SVG document with literal colours. */
export function coverSvg(scene: CoverScene, colors: CoverColors): string {
	const paint = (p: CoverPaint) => (p === "ink" ? colors.ink : p === "bg" ? colors.background : "none");
	const body = scene.shapes
		.map((s) => {
			if (s.type === "path") {
				const fillOpacity = s.fillOpacity !== undefined ? ` fill-opacity="${s.fillOpacity}"` : "";
				return `<path d="${s.d}" fill="${paint(s.fill)}"${fillOpacity} stroke="${colors.ink}" stroke-opacity="${s.opacity}" stroke-width="${s.stroke}" stroke-linejoin="round"/>`;
			}
			const stroke = s.stroke ? ` stroke="${colors.ink}" stroke-width="${s.stroke}"` : "";
			return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="${paint(s.fill)}" opacity="${s.opacity}"${stroke}/>`;
		})
		.join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.width} ${scene.height}" width="${scene.width}" height="${scene.height}"><rect width="100%" height="100%" fill="${colors.background}"/>${body}</svg>`;
}
