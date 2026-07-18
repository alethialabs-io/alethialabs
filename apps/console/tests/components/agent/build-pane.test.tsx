// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BuildPane } from "@/components/agent/build-pane";
import type { BuildServiceInput } from "@/lib/agent/build-status";

const repo = (name: string, resolved_image: string | null = null): BuildServiceInput => ({
	name,
	source: { kind: "repo", repo_url: `https://github.com/acme/${name}`, path: "." },
	resolved_image,
});
const image = (name: string): BuildServiceInput => ({
	name,
	source: { kind: "image", image: "ghcr.io/acme/x:1.0" },
});

describe("BuildPane", () => {
	it("lists repo-sourced services with a phase and, when pushed, the short digest", () => {
		render(
			<BuildPane
				services={[repo("api", "111.dkr.ecr.eu-west-1.amazonaws.com/api@sha256:abcdef123456")]}
				build={null}
			/>,
		);
		expect(screen.getByText("api")).toBeInTheDocument();
		expect(screen.getByText("Pushed")).toBeInTheDocument();
		// short digest = repo tail @ first 12 of the sha
		expect(screen.getByText("api@abcdef123456")).toBeInTheDocument();
	});

	it("notes prebuilt-image services rather than showing them as build rows", () => {
		render(<BuildPane services={[repo("api"), image("web")]} build={null} />);
		expect(screen.getByText("api")).toBeInTheDocument();
		expect(screen.queryByText("web")).not.toBeInTheDocument();
		expect(screen.getByText(/prebuilt-image service/)).toBeInTheDocument();
	});

	it("shows an empty state when nothing is repo-sourced", () => {
		render(<BuildPane services={[image("web")]} build={null} />);
		expect(screen.getByText(/nothing to build/)).toBeInTheDocument();
	});
});
