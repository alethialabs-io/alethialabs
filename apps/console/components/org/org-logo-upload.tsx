"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@repo/ui/button";
import { OrgAvatar } from "@/components/org/org-avatar";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";

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

	async function upload(file: File) {
		setBusy(true);
		try {
			const res = await fetch("/api/org/logo", {
				method: "POST",
				body: file,
				headers: { "content-type": file.type },
			});
			if (!res.ok) {
				const { error } = await res.json().catch(() => ({}));
				throw new Error(error ?? "Upload failed");
			}
			const { url } = await res.json();
			onChange(url);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't upload the logo.");
		} finally {
			setBusy(false);
			if (inputRef.current) inputRef.current.value = "";
		}
	}

	async function remove() {
		setBusy(true);
		try {
			await fetch("/api/org/logo", { method: "DELETE" });
			onChange(null);
		} catch {
			toast.error("Couldn't remove the logo.");
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
						onClick={() => void remove()}
					>
						Remove
					</Button>
				)}
			</div>
		</div>
	);
}
