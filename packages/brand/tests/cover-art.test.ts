// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { COVER_SIZES, coverScene, coverSvg, MOTIFS, pickMotif } from "../src/cover/cover-art";

const COLORS = { background: "#040404", ink: "#fafafa" };
const KINDS = ["announcement", "product", "engineering", "changelog", "company"];

describe("coverScene", () => {
	it("is deterministic: the same slug, kind and aspect draw byte-identical art", () => {
		const a = coverSvg(coverScene("instant-provisioning", "engineering", "hero"), COLORS);
		const b = coverSvg(coverScene("instant-provisioning", "engineering", "hero"), COLORS);
		expect(a).toBe(b);
	});

	it("draws a different picture for every slug in a realistic set", () => {
		const slugs = Array.from({ length: 60 }, (_, i) => `changelog-2026-${String(i).padStart(2, "0")}`);
		const drawn = new Set(slugs.map((slug) => coverSvg(coverScene(slug, "changelog"), COLORS)));
		expect(drawn.size).toBe(slugs.length);
	});

	it("keeps a post's motif across the hero, the card and the OG frame", () => {
		const motifs = (["hero", "card", "og"] as const).map((aspect) => coverScene("open-source-self-host", "announcement", aspect).motif);
		expect(new Set(motifs).size).toBe(1);
	});

	it("draws in the frame it was asked for", () => {
		for (const aspect of ["hero", "card", "og"] as const) {
			const scene = coverScene("x", "company", aspect);
			expect({ width: scene.width, height: scene.height }).toEqual(COVER_SIZES[aspect]);
			expect(coverSvg(scene, COLORS)).toContain(`viewBox="0 0 ${scene.width} ${scene.height}"`);
		}
	});

	it("reaches every motif family across kinds", () => {
		const seen = new Set<string>();
		for (const kind of KINDS) for (let i = 0; i < 40; i++) seen.add(pickMotif(`post-${i}`, kind));
		expect([...seen].sort()).toEqual([...MOTIFS].sort());
	});

	it("falls back to every family for a kind it does not know", () => {
		expect(MOTIFS).toContain(pickMotif("anything", "not-a-kind"));
	});

	it("uses only the two colours it is given — the art is grayscale by construction", () => {
		const svg = coverSvg(coverScene("per-project-ai-memory", "engineering", "og"), COLORS);
		const colours = new Set(svg.match(/#[0-9a-f]{6}/gi));
		expect([...colours].sort()).toEqual(["#040404", "#fafafa"]);
		expect(svg).not.toMatch(/NaN|undefined/);
	});
});
