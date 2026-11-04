// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cluster card's "Download kubeconfig (1h, read-only)" control (#5285): hidden without
// `cluster:access_readonly` (answered by the clusters read, #6122 — the control asks nothing itself); with it, one click requests, polls, opens and saves — the real HPKE open
// over the Go-sealed vector blob, with the vector's key injected in place of the browser's random one.

import { readFileSync } from "node:fs";
import path from "node:path";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const V: {
	recipient_sk_hex: string;
	recipient_pk_b64url: string;
	mint_id: string;
	cluster_id: string;
	sealed_b64url: string;
} = JSON.parse(
	readFileSync(
		path.resolve(__dirname, "../../../../../../packages/core/kubeaccess/testdata/seal_vectors.json"),
		"utf8",
	),
).alethia_mint;

vi.mock("@/app/server/actions/kubeconfig-download", () => ({
	requestKubeconfigDownload: vi.fn(),
	pollKubeconfigDownload: vi.fn(),
}));

// The real hpke module, with key generation pinned to the vector's recipient so the Go-sealed blob
// opens. Support detection stays real (this runtime has X25519).
vi.mock("@/components/clusters/kubeconfig-download/hpke", async (importActual) => {
	const actual = await importActual<typeof import("@/components/clusters/kubeconfig-download/hpke")>();
	return {
		...actual,
		generateRecipientKey: async () => {
			const sk = Uint8Array.from(V.recipient_sk_hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
			const pk = actual.fromBase64Url(V.recipient_pk_b64url);
			const privateKey = await crypto.subtle.importKey(
				"jwk",
				{ kty: "OKP", crv: "X25519", d: actual.toBase64Url(sk), x: actual.toBase64Url(pk) },
				{ name: "X25519" },
				false,
				["deriveBits"],
			);
			return { privateKey, publicKey: pk };
		},
	};
});

import {
	pollKubeconfigDownload,
	requestKubeconfigDownload,
} from "@/app/server/actions/kubeconfig-download";
import { KubeconfigDownload } from "@/components/clusters/kubeconfig-download/kubeconfig-download";

/** Renders the control as the cluster card does, with the read's answer for `allowed`. */
function render(allowed = true) {
	return rtlRender(
		<KubeconfigDownload clusterId={V.cluster_id} projectName="Shop" environment="dev" allowed={allowed} />,
	);
}

const BUTTON = /download kubeconfig \(1h, read-only\)/i;

describe("KubeconfigDownload", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders nothing for someone without cluster:access_readonly", () => {
		const { container } = render(false);
		expect(screen.queryByRole("button", { name: BUTTON })).toBeNull();
		expect(container).toBeEmptyDOMElement();
	});

	it("paints the button on first render for someone who holds it — no request of its own", () => {
		render(true);
		expect(screen.getByRole("button", { name: BUTTON })).toBeInTheDocument();
		expect(requestKubeconfigDownload).not.toHaveBeenCalled();
		expect(pollKubeconfigDownload).not.toHaveBeenCalled();
	});

	it("downloads: requests read-only with only the public key, opens the seal, saves the file, says when it expires", async () => {
		vi.mocked(requestKubeconfigDownload).mockResolvedValue({
			ok: true,
			mintId: V.mint_id,
			pollExpiresAt: "2099-01-01T00:00:00.000Z",
		});
		vi.mocked(pollKubeconfigDownload).mockResolvedValue({
			ok: true,
			poll: { status: "ready", private_endpoint: true, sealed: V.sealed_b64url },
		});
		const blobs: Blob[] = [];
		const createObjectURL = vi.fn((b: Blob) => {
			blobs.push(b);
			return "blob:test";
		});
		const revokeObjectURL = vi.fn();
		Object.assign(URL, { createObjectURL, revokeObjectURL });
		const clicks: string[] = [];
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
			clicks.push(this.download);
		});

		render();
		await userEvent.click(await screen.findByRole("button", { name: BUTTON }));

		await screen.findByText(/alethia-shop-dev\.kubeconfig/);
		expect(requestKubeconfigDownload).toHaveBeenCalledExactlyOnceWith({
			clusterId: V.cluster_id,
			clientPublicKey: V.recipient_pk_b64url,
		});
		expect(clicks).toEqual(["alethia-shop-dev.kubeconfig"]);
		expect(await blobs[0].text()).toBe("apiVersion: v1\nkind: Config\n");
		await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:test"));
		expect(screen.getByText(/expires/i)).toBeInTheDocument();
		expect(screen.getByText(/API endpoint is private/)).toBeInTheDocument();
	});

	it("over plain HTTP (not a secure context) says it needs HTTPS and requests nothing", async () => {
		// jsdom does not report isSecureContext; a browser on a plain-HTTP origin reports false.
		Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
		try {
			render();
			await userEvent.click(await screen.findByRole("button", { name: BUTTON }));
			expect(await screen.findByRole("alert")).toHaveTextContent(/needs HTTPS/);
			expect(requestKubeconfigDownload).not.toHaveBeenCalled();
		} finally {
			Reflect.deleteProperty(window, "isSecureContext");
		}
	});

	it("shows the refusal's message and saves nothing", async () => {
		vi.mocked(requestKubeconfigDownload).mockResolvedValue({ ok: false, status: 429 });
		render();
		await userEvent.click(await screen.findByRole("button", { name: BUTTON }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/Too many kubeconfig requests/);
		expect(pollKubeconfigDownload).not.toHaveBeenCalled();
	});
});
