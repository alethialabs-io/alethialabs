"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@repo/ui/button";
// The console's one confirmation dialog, shared across features (environments-view.tsx, the canvas
// inspector) — a second copy here would be the drift CLAUDE.md §6 is about, not a fix for it.
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { OrgAvatar } from "@/components/org/org-avatar";
import { endSession } from "@/lib/stores/use-session-state";

const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];
const ACCEPT = ACCEPTED_TYPES.join(",");
/** The route's own ceiling (`app/api/org/logo/route.ts`, `MAX_BYTES`), checked here first. */
const MAX_BYTES = 2 * 1024 * 1024;

/** An image over {@link MAX_BYTES}: the route's 413, said before the upload is sent. */
const TOO_LARGE = "That image is larger than 2 MB. Choose a smaller one.";
/** An image type the route does not store: its 415, said before the upload is sent. */
const WRONG_TYPE = "Use a PNG, JPEG, WebP, GIF or SVG image.";

/** Which request a failure belongs to. */
type LogoRequest = "upload" | "remove";

/**
 * The sentence for a refused or failed `/api/org/logo` call, decided by STATUS, never by the
 * route's body (CON-L3, R6 E-05 and E-06). The route answers `{ error: "Forbidden" }` for a 403,
 * which is a word for a log, not for a person. A 401 has no sentence: it returns `null`, and the
 * caller ends the session so the console's one session-ended dialog says it (SM3).
 */
export function logoFailureMessage(request: LogoRequest, status: number): string | null {
	if (status === 401) return null;
	if (status === 403) return "Only owners and admins can change the organization logo.";
	if (request === "upload") {
		if (status === 413) return TOO_LARGE;
		if (status === 415) return WRONG_TYPE;
		if (status === 400) return "That image couldn't be read. Choose another file.";
		return "Couldn't upload the logo. Try again.";
	}
	return "Couldn't remove the logo. Try again.";
}

/**
 * The sentence for a request that never got an answer. An upload that did not arrive changed
 * nothing; a removal may have landed before the connection dropped, so it says to check first —
 * the same split the mutation contract makes between a request that was and was not sent.
 */
export function logoNetworkMessage(request: LogoRequest): string {
	return request === "upload"
		? "Couldn't reach Alethia, so the logo wasn't changed. Check your connection and try again."
		: "We couldn't confirm the logo was removed. Reload the page to check before trying again.";
}

/** Reports a refused `/api/org/logo` call: ends the session on a 401, toasts anything else. */
function reportLogoFailure(request: LogoRequest, status: number): void {
	const message = logoFailureMessage(request, status);
	if (message === null) {
		endSession();
		return;
	}
	toast.error(message);
}

/** Reads the served URL out of a successful upload's body, or null if it carries none. */
async function uploadedUrl(res: Response): Promise<string | null> {
	const body: unknown = await res.json().catch(() => null);
	if (typeof body !== "object" || body === null || !("url" in body)) return null;
	return typeof body.url === "string" ? body.url : null;
}

interface OrgLogoUploadProps {
	name: string;
	logo: string | null;
	/** Called with the new served URL after upload, or null after remove. */
	onChange: (url: string | null) => void;
	size?: number;
}

/**
 * Organization logo control: avatar preview + upload/remove. Posts the raw image to
 * `/api/org/logo` (owner/admin of the active org) and reports the served URL back.
 * Requires the active organization to be set (onboarding sets it on mount; settings
 * already runs scoped to the active org).
 */
export function OrgLogoUpload({ name, logo, onChange, size = 56 }: OrgLogoUploadProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	// `Remove` used to fire the DELETE on a bare click — one of the nineteen controls
	// `apps/console/destructive-actions.yaml` recorded as `status: missing`. There is no undo: the
	// stored object is gone and the only way back is to find the original file and upload it again.
	const [confirmOpen, setConfirmOpen] = useState(false);

	/** Uploads a new logo and reports the served URL, or says why it was not changed. */
	async function upload(file: File) {
		// The two refusals the browser can decide without a round trip, in the route's own words.
		if (!ACCEPTED_TYPES.includes(file.type)) {
			toast.error(WRONG_TYPE);
			resetInput();
			return;
		}
		if (file.size > MAX_BYTES) {
			toast.error(TOO_LARGE);
			resetInput();
			return;
		}
		setBusy(true);
		try {
			let res: Response;
			try {
				res = await fetch("/api/org/logo", {
					method: "POST",
					body: file,
					headers: { "content-type": file.type },
				});
			} catch {
				toast.error(logoNetworkMessage("upload"));
				return;
			}
			if (!res.ok) {
				reportLogoFailure("upload", res.status);
				return;
			}
			const url = await uploadedUrl(res);
			if (url === null) {
				toast.error("Couldn't upload the logo. Try again.");
				return;
			}
			onChange(url);
		} finally {
			setBusy(false);
			resetInput();
		}
	}

	/** Clears the file input so choosing the same file again fires `change`. */
	function resetInput() {
		if (inputRef.current) inputRef.current.value = "";
	}

	/**
	 * Removes the stored logo. Answers whether it was removed, which closes the confirmation: a
	 * refusal used to read as success, because the response's status was never looked at (R6 E-05).
	 */
	async function remove(): Promise<boolean> {
		setBusy(true);
		try {
			let res: Response;
			try {
				res = await fetch("/api/org/logo", { method: "DELETE" });
			} catch {
				toast.error(logoNetworkMessage("remove"));
				return false;
			}
			if (!res.ok) {
				reportLogoFailure("remove", res.status);
				return false;
			}
			onChange(null);
			return true;
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex items-center gap-4">
			<OrgAvatar name={name} logo={logo} size={size} />
			<input
				ref={inputRef}
				type="file"
				accept={ACCEPT}
				hidden
				onChange={(e) => {
					const f = e.target.files?.[0];
					if (f) void upload(f);
				}}
			/>
			<div className="flex items-center gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={busy}
					onClick={() => inputRef.current?.click()}
				>
					{busy ? "Uploading…" : logo ? "Replace" : "Upload image"}
				</Button>
				{logo && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={busy}
						onClick={() => setConfirmOpen(true)}
					>
						Remove
					</Button>
				)}
			</div>
			{/* The dialog is rendered unconditionally rather than behind `logo &&`: unmounting it in
			    the same commit that `onChange(null)` triggers is how a confirmation ends up leaking
			    its overlay. `AlertDialog` handles its own closed state. */}
			<ConfirmAction
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title="Remove the organization logo?"
				description={`${name} will fall back to its initials everywhere it is shown. This cannot be undone — you would need the original image file to put it back.`}
				confirmLabel="Remove logo"
				pendingLabel="Removing…"
				severity={{ level: "confirm" }}
				run={remove}
			/>
		</div>
	);
}
