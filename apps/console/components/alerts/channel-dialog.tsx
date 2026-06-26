"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { type ReactNode, useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
	type ChannelDTO,
	createChannel,
	updateChannel,
} from "@/app/server/actions/alerts";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Switch } from "@repo/ui/switch";
import type { AlertChannelType } from "@/lib/db/schema/enums";

const CHANNEL_TYPES: { value: AlertChannelType; label: string }[] = [
	{ value: "webhook", label: "Webhook" },
	{ value: "email", label: "Email" },
	{ value: "slack", label: "Slack" },
	{ value: "rocketchat", label: "RocketChat" },
];

const URL_LABEL: Partial<Record<AlertChannelType, string>> = {
	webhook: "Endpoint URL",
	slack: "Slack incoming-webhook URL",
	rocketchat: "RocketChat webhook URL",
};

// What credential to paste and where to get it — chat channels authenticate with an
// incoming-webhook URL (no OAuth); Alethia just POSTs to it.
const TYPE_HELP: Record<AlertChannelType, ReactNode> = {
	slack: (
		<>
			In Slack: <span className="text-foreground">Apps → Incoming Webhooks → Add to a channel</span>,
			then copy the webhook URL. Alethia POSTs messages to it — no OAuth, no app install
			beyond the webhook.{" "}
			<a
				href="https://api.slack.com/messaging/webhooks"
				target="_blank"
				rel="noreferrer"
				className="underline underline-offset-2 hover:text-foreground"
			>
				Slack docs
			</a>
		</>
	),
	rocketchat: (
		<>
			In RocketChat:{" "}
			<span className="text-foreground">Admin → Integrations → New → Incoming Webhook</span>, enable
			it, then copy the generated URL.
		</>
	),
	webhook: (
		<>
			Any HTTPS endpoint. With a signing secret, the body is signed{" "}
			<code className="font-mono text-[11px]">X-Alethia-Signature: sha256=HMAC</code> so your
			receiver can verify it.
		</>
	),
	email: (
		<>
			Comma-separated addresses. Delivery uses the server&apos;s SES/SMTP if configured; otherwise
			it&apos;s logged (no setup needed to try it).
		</>
	),
};

const schema = z.object({
	type: z.enum(["webhook", "email", "slack", "rocketchat"]),
	name: z.string().min(1, "Name your channel"),
	enabled: z.boolean(),
	url: z.string().optional(),
	signingSecret: z.string().optional(),
	recipients: z.string().optional(), // comma/newline separated
});
type FormData = z.infer<typeof schema>;

interface ChannelDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Existing channel to edit; omit to create. */
	channel?: ChannelDTO;
	/** Whether ALETHIA_CRED_ENCRYPTION_KEY is set (secret channels need it). */
	encryptionConfigured: boolean;
	onSaved: () => void;
}

/** Create/edit a notification channel. Secrets are write-only (blank on edit). */
export function ChannelDialog({
	open,
	onOpenChange,
	channel,
	encryptionConfigured,
	onSaved,
}: ChannelDialogProps) {
	const [saving, setSaving] = useState(false);
	const {
		control,
		register,
		handleSubmit,
		watch,
		reset,
		formState: { errors },
	} = useForm<FormData>({
		resolver: zodResolver(schema),
		defaultValues: {
			type: channel?.type ?? "webhook",
			name: channel?.name ?? "",
			enabled: channel?.enabled ?? true,
			url: "",
			signingSecret: "",
			recipients: channel?.recipients.join(", ") ?? "",
		},
	});

	// Reset when the target channel changes (open the dialog for a different row).
	useEffect(() => {
		reset({
			type: channel?.type ?? "webhook",
			name: channel?.name ?? "",
			enabled: channel?.enabled ?? true,
			url: "",
			signingSecret: "",
			recipients: channel?.recipients.join(", ") ?? "",
		});
	}, [channel, reset]);

	const type = watch("type");
	// Secret-bearing channels can't be saved without the encryption key.
	const needsKey = type !== "email" && !encryptionConfigured;

	const onSubmit = async (data: FormData) => {
		const recipients =
			data.type === "email"
				? (data.recipients ?? "")
						.split(/[,\n]/)
						.map((s) => s.trim())
						.filter(Boolean)
				: undefined;

		const secret =
			data.type === "email"
				? undefined
				: {
						url: data.url || undefined,
						signingSecret:
							data.type === "webhook" ? data.signingSecret || undefined : undefined,
					};

		// On create, a destination is required; on edit a blank URL keeps the old one.
		if (!channel && data.type !== "email" && !secret?.url) {
			toast.error("A destination URL is required.");
			return;
		}
		if (data.type === "email" && (recipients?.length ?? 0) === 0) {
			toast.error("Add at least one recipient.");
			return;
		}

		setSaving(true);
		try {
			const input = {
				type: data.type,
				name: data.name,
				enabled: data.enabled,
				recipients,
				secret,
			};
			if (channel) await updateChannel(channel.id, input);
			else await createChannel(input);
			toast.success(channel ? "Channel updated" : "Channel created");
			onOpenChange(false);
			onSaved();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to save channel");
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{channel ? "Edit channel" : "New channel"}</DialogTitle>
					<DialogDescription>
						Where alerts get delivered. Secrets are encrypted at rest and never
						shown again.
					</DialogDescription>
				</DialogHeader>

				<form
					onSubmit={handleSubmit(onSubmit)}
					className="space-y-4"
					id="channel-form"
				>
					<div className="space-y-2">
						<Label>Type</Label>
						<Controller
							control={control}
							name="type"
							render={({ field }) => (
								<Select value={field.value} onValueChange={field.onChange}>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{CHANNEL_TYPES.map((t) => (
											<SelectItem key={t.value} value={t.value}>
												{t.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						/>
					</div>

					<div className="space-y-2">
						<Label>Name</Label>
						<Input placeholder="#ops Slack" {...register("name")} />
						{errors.name && (
							<p className="text-destructive text-xs">{errors.name.message}</p>
						)}
					</div>

					{needsKey && (
						<div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-xs">
							This channel stores a URL secret, which needs an encryption key. Set{" "}
							<code className="font-mono text-foreground">ALETHIA_CRED_ENCRYPTION_KEY</code>{" "}
							(generate: <code className="font-mono">openssl rand -base64 32</code>) and
							restart, or use an Email channel.
						</div>
					)}

					{type === "email" ? (
						<div className="space-y-2">
							<Label>Recipients</Label>
							<Input
								placeholder="oncall@acme.io, security@acme.io"
								{...register("recipients")}
							/>
							<p className="text-muted-foreground text-xs">{TYPE_HELP.email}</p>
						</div>
					) : (
						<>
							<div className="space-y-2">
								<Label>{URL_LABEL[type] ?? "URL"}</Label>
								<Input
									placeholder={
										channel ? "•••••• (leave blank to keep current)" : "https://…"
									}
									{...register("url")}
								/>
								<p className="text-muted-foreground text-xs">{TYPE_HELP[type]}</p>
							</div>
							{type === "webhook" && (
								<div className="space-y-2">
									<Label>Signing secret (optional)</Label>
									<Input
										placeholder="HMAC secret for X-Alethia-Signature"
										{...register("signingSecret")}
									/>
								</div>
							)}
						</>
					)}

					<div className="flex items-center justify-between">
						<Label>Enabled</Label>
						<Controller
							control={control}
							name="enabled"
							render={({ field }) => (
								<Switch checked={field.value} onCheckedChange={field.onChange} />
							)}
						/>
					</div>
				</form>

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={saving}
					>
						Cancel
					</Button>
					<Button type="submit" form="channel-form" disabled={saving || needsKey}>
						{saving ? "Saving…" : channel ? "Save" : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
