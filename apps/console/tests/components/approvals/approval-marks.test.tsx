// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7645 — what asked for an approval wears its mark: a connected agent the catalogue knows is drawn
// with its brand mark, keyed by its OAuth client id; an unknown one with the icon it registered, or a
// neutral glyph; every other credential with a neutral glyph. Never a letter, and never announced —
// the name beside the mark carries the identity.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RequesterMark } from "@/components/approvals/approval-marks";
import type { ApprovalListItem } from "@/lib/queries/approvals";

/** What asked, as an approval row carries it. */
type Asked = Pick<
	ApprovalListItem,
	"requester_credential" | "requester_credential_name" | "requester_credential_ref" | "requester_credential_icon"
>;

/** A connected agent with nothing known about it; `over` replaces fields. */
function asked(over: Partial<Asked>): Asked {
	return {
		requester_credential: "agent_oauth",
		requester_credential_name: null,
		requester_credential_ref: null,
		requester_credential_icon: null,
		...over,
	};
}

describe("RequesterMark", () => {
	it.each([
		["https://claude.ai/code/oauth/metadata.json", "claudecode"],
		["https://claude.ai/oauth/metadata.json", "claude"],
		["https://cursor.com/oauth/client.json", "cursor"],
		["https://vscode.dev/oauth/client-metadata.json", "githubcopilot"],
		["https://chatgpt.com/codex/oauth.json", "openai"],
	])("a known agent (%s) is drawn with its brand mark", (ref, mark) => {
		const { container } = render(<RequesterMark approval={asked({ requester_credential_ref: ref })} />);
		expect(container.querySelector(`[data-mark="${mark}"]`)).not.toBeNull();
		expect(container.querySelector('[data-mark="glyph"]')).toBeNull();
	});

	it("a known agent's mark ignores whatever icon its client registered", () => {
		const { container } = render(
			<RequesterMark
				approval={asked({ requester_credential_ref: "https://cursor.com/c.json", requester_credential_icon: "https://evil.example/x.png" })}
			/>,
		);
		expect(container.querySelector('img[src="https://evil.example/x.png"]')).toBeNull();
	});

	it("an unknown agent shows the icon it registered, decoratively", () => {
		const { container } = render(
			<RequesterMark
				approval={asked({
					requester_credential_ref: "https://tools.acme.io/client.json",
					requester_credential_name: "Release helper",
					requester_credential_icon: "https://tools.acme.io/icon.png",
				})}
			/>,
		);
		const img = container.querySelector("img");
		expect(img?.getAttribute("src")).toBe("https://tools.acme.io/icon.png");
		expect(img?.getAttribute("alt")).toBe("");
	});

	it("an unknown agent with no icon is a neutral glyph, never a letter", () => {
		const { container } = render(
			<RequesterMark approval={asked({ requester_credential_ref: "https://tools.acme.io/client.json", requester_credential_name: "Release helper" })} />,
		);
		expect(container.querySelector('[data-mark="glyph"]')).not.toBeNull();
		expect(container.textContent).toBe("");
	});

	it.each(["session", "cli_session", "agent_in_app", "service_token"] as const)("%s is a neutral, hidden glyph", (credential) => {
		const { container } = render(<RequesterMark approval={asked({ requester_credential: credential })} />);
		const glyph = container.querySelector('[data-mark="credential"]');
		expect(glyph).not.toBeNull();
		expect(glyph?.getAttribute("aria-hidden")).toBe("true");
		expect(container.textContent).toBe("");
	});

	it("is never announced: the name beside it carries the identity", () => {
		const { container } = render(<RequesterMark approval={asked({ requester_credential_ref: "https://cursor.com/c.json" })} />);
		expect(container.querySelector('[role="img"]')).toBeNull();
	});
});
