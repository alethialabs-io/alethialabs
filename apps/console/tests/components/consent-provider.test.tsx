// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { CONSENT_COOKIE, writeConsent } from "@repo/privacy/consent";
import { ConsentProvider } from "@repo/privacy/consent-provider";

describe("ConsentProvider", () => {
	beforeEach(() => {
		document.cookie = `${CONSENT_COOKIE}=; Path=/; Max-Age=0`;
	});

	it("pins the first-visit notice to the right and uses the configured notice URL", async () => {
		render(
			<ConsentProvider cookieNoticeHref="https://alethialabs.io/cookies">
				<div>Product</div>
			</ConsentProvider>,
		);

		const notice = await screen.findByRole("region", { name: "Privacy choices" });
		expect(notice).toHaveClass("sm:left-auto");
		expect(notice).toHaveClass("sm:w-[28rem]");
		expect(screen.getByRole("link", { name: "Cookie notice" })).toHaveAttribute(
			"href",
			"https://alethialabs.io/cookies",
		);
	});

	it("hides the floating launcher in the console after a decision", async () => {
		writeConsent({ analytics: false, replay: false });

		render(
			<ConsentProvider showPersistentTrigger={false}>
				<div>Console</div>
			</ConsentProvider>,
		);

		await waitFor(() => {
			expect(screen.queryByRole("region", { name: "Privacy choices" })).not.toBeInTheDocument();
		});
		expect(
			screen.queryByRole("button", { name: "Privacy choices" }),
		).not.toBeInTheDocument();
	});

	it("keeps the public launcher at bottom-right and opens preferences", async () => {
		writeConsent({ analytics: false, replay: false });

		render(
			<ConsentProvider>
				<div>Marketing</div>
			</ConsentProvider>,
		);

		const launcher = await screen.findByRole("button", { name: "Privacy choices" });
		expect(launcher).toHaveClass("bottom-4");
		expect(launcher).toHaveClass("right-4");
		expect(launcher).not.toHaveClass("left-4");

		fireEvent.click(launcher);
		expect(
			await screen.findByRole("dialog", { name: "Choose what Alethia may collect." }),
		).toBeInTheDocument();
	});
});
