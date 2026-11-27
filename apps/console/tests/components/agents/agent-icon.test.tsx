// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The agent marks (SPEC §5a, ruling #3907): every catalogue app has a real mark, named after the app;
// marks are in their owners' colours (a two-variant owner gets exactly its light and dark fills);
// GitHub Copilot draws GitHub's own Invertocat files (Copilot has no standalone logo); OpenAI Codex
// draws OpenAI's own files; an unknown app shows its own https icon or a neutral glyph — never a
// letter.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentIcon } from "@/components/agents/agent-icon";
import { AGENT_APPS } from "@/lib/agents/catalog";

describe("AgentIcon", () => {
	it.each(AGENT_APPS.map((app) => [app.name, app.mark] as const))("%s has a real mark named after it", (name, mark) => {
		render(<AgentIcon mark={mark} name={name} />);
		expect(screen.getAllByRole("img", { name }).length).toBeGreaterThan(0);
		expect(document.querySelector('[data-mark="glyph"]')).toBeNull();
	});

	it("draws Claude Code in Clay on both themes", () => {
		const { container } = render(<AgentIcon mark="claudecode" name="Claude Code" />);
		const paths = container.querySelectorAll("path");
		expect(paths).toHaveLength(1);
		expect(paths[0]?.getAttribute("fill")).toBe("#D97757");
	});

	it("draws Cursor in its owner's light and dark variants, one per theme", () => {
		const { container } = render(<AgentIcon mark="cursor" name="Cursor" />);
		const fills = [...container.querySelectorAll("path")].map((p) => [p.getAttribute("fill"), p.getAttribute("class")]);
		expect(fills).toEqual([
			["#26251E", "dark:hidden"],
			["#EDECEC", "hidden dark:block"],
		]);
	});

	it("draws GitHub Copilot as GitHub's own Invertocat files, black on light and white on dark", () => {
		const { container } = render(<AgentIcon mark="githubcopilot" name="GitHub Copilot" />);
		// No path of our own: the mark is GitHub's file, unmodified, never a redrawn Copilot icon.
		expect(container.querySelector("path")).toBeNull();
		const imgs = screen.getAllByRole("img", { name: "GitHub Copilot" });
		const black = imgs.find((img) => (img.getAttribute("src") ?? "").includes("GitHub_Invertocat_Black.png"));
		const white = imgs.find((img) => (img.getAttribute("src") ?? "").includes("GitHub_Invertocat_White.png"));
		expect(black?.getAttribute("class")?.split(" ")).toContain("dark:hidden");
		expect(white?.getAttribute("class")?.split(" ")).toEqual(expect.arrayContaining(["hidden", "dark:block"]));
	});

	it("draws OpenAI Codex from OpenAI's own Blossom files", () => {
		render(<AgentIcon mark="openai" name="OpenAI Codex" />);
		const srcs = screen.getAllByRole("img", { name: "OpenAI Codex" }).map((img) => img.getAttribute("src") ?? "");
		expect(srcs.some((s) => s.includes("OAI_OpenAI-Blossom_Black.svg"))).toBe(true);
		expect(srcs.some((s) => s.includes("OAI_OpenAI-Blossom_White.svg"))).toBe(true);
	});

	it("an unknown app shows its own https icon, and the neutral glyph when it fails to load", () => {
		const { container } = render(<AgentIcon icon="https://tools.acme.io/icon.png" name="Release bot" />);
		const img = screen.getByRole("img", { name: "Release bot" });
		expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
		fireEvent.error(img);
		expect(container.querySelector('[data-mark="glyph"]')).not.toBeNull();
		expect(container.textContent).toBe("");
	});

	it("never loads a non-https icon and never draws a letter", () => {
		const { container } = render(<AgentIcon icon="http://tools.acme.io/icon.png" name="Release bot" />);
		expect(container.querySelector("img")).toBeNull();
		expect(container.querySelector('[data-mark="glyph"]')).not.toBeNull();
		expect(container.textContent).toBe("");
	});
});
