"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useState, useTransition } from "react";
import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { CountrySelect } from "@/components/ui/country-select";
import { PhoneInput } from "@/components/ui/phone-input";
import { submitContactLead } from "@/app/server/actions/contact";
import { disp, Icon, mono } from "@/components/landing/home/primitives";
import {
	contactLeadSchema,
	DEFAULT_COUNTRY,
	INTERESTS,
	SALES_MAIL,
	SIZES,
	type ContactLeadInput,
	type ContactLeadType,
} from "@/lib/validations/contact.schema";

/** Field label, with an optional "optional" tag mirroring the design. */
function FieldLabel({
	children,
	optional,
}: {
	children: React.ReactNode;
	optional?: boolean;
}) {
	return (
		<span style={{ display: "flex", alignItems: "center" }}>
			<span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--text-secondary)" }}>
				{children}
			</span>
			{optional && (
				<span
					style={{
						...mono,
						fontSize: 10,
						letterSpacing: "0.04em",
						textTransform: "uppercase",
						color: "var(--text-disabled)",
						marginLeft: 8,
					}}
				>
					optional
				</span>
			)}
		</span>
	);
}

/**
 * Shared contact form for the Talk-to-sales and Enterprise-trial pages. Wires
 * react-hook-form + the shared zod schema into our UI kit, posts to the public
 * `submitContactLead` server action, and swaps to a success card on success.
 * Only `type` (the lead discriminator) and `submitLabel` differ per page.
 */
export function ContactForm({
	type,
	submitLabel,
}: {
	type: ContactLeadType;
	submitLabel: string;
}) {
	const [sent, setSent] = useState(false);
	const [pending, startTransition] = useTransition();

	const form = useForm<ContactLeadInput>({
		resolver: zodResolver(contactLeadSchema),
		mode: "onChange",
		defaultValues: {
			type,
			email: "",
			name: "",
			country: DEFAULT_COUNTRY,
			phone: "",
			website: "",
			companySize: undefined,
			interest: undefined,
			message: "",
			consent: false,
			honeypot: "",
		},
	});

	/** Submit via the server action; show success card or toast the error. */
	function onSubmit(values: ContactLeadInput) {
		startTransition(async () => {
			try {
				await submitContactLead(values);
				setSent(true);
			} catch (err) {
				toast.error(
					err instanceof Error
						? err.message
						: "Something went wrong — please try again.",
				);
			}
		});
	}

	const firstName = form.getValues("name").trim().split(" ")[0];

	if (sent) {
		return (
			<div
				style={{
					border: "1px solid var(--border)",
					borderRadius: "var(--radius-xl)",
					background: "var(--surface)",
					boxShadow: "var(--shadow-md)",
					padding: "48px 40px",
					textAlign: "center",
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
				}}
			>
				<span
					style={{
						display: "grid",
						placeItems: "center",
						width: 52,
						height: 52,
						borderRadius: "var(--radius-full)",
						border: "1px solid var(--border-strong)",
						background: "var(--surface-muted)",
						color: "var(--text-primary)",
						marginBottom: 22,
					}}
				>
					<Icon k="check" size={24} sw={2.2} />
				</span>
				<h3
					style={{
						...disp,
						fontSize: 24,
						fontWeight: 600,
						letterSpacing: "-0.03em",
						margin: "0 0 10px",
						color: "var(--text-primary)",
					}}
				>
					Thanks{firstName ? `, ${firstName}` : ""}.
				</h3>
				<p
					style={{
						fontSize: 14.5,
						color: "var(--text-tertiary)",
						margin: "0 0 26px",
						maxWidth: 340,
						lineHeight: 1.6,
					}}
				>
					Your request is in. Someone from our team will reach out — usually
					within one business day.
				</p>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 9,
						...mono,
						fontSize: 11.5,
						color: "var(--text-disabled)",
					}}
				>
					<Icon k="lock" size={13} sw={1.7} />
					Prefer email?{" "}
					<a href={`mailto:${SALES_MAIL}`} style={{ color: "var(--text-secondary)" }}>
						{SALES_MAIL}
					</a>
				</div>
			</div>
		);
	}

	return (
		<Form {...form}>
			<form
				onSubmit={form.handleSubmit(onSubmit)}
				style={{
					border: "1px solid var(--border)",
					borderRadius: "var(--radius-xl)",
					background: "var(--surface)",
					boxShadow: "var(--shadow-md)",
					overflow: "hidden",
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 10,
						padding: "16px 24px",
						borderBottom: "1px solid var(--border)",
						background: "var(--surface-muted)",
					}}
				>
					<Icon k="building" size={15} />
					<span style={{ ...disp, fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
						Tell us about your team
					</span>
					<span style={{ ...mono, fontSize: 10, color: "var(--text-tertiary)", marginLeft: "auto" }}>
						2 min
					</span>
				</div>

				<div style={{ padding: "24px 24px 26px", display: "flex", flexDirection: "column", gap: 16 }}>
					{/* Honeypot — hidden from humans; bots that fill it are dropped server-side. */}
					<input
						{...form.register("honeypot")}
						type="text"
						tabIndex={-1}
						autoComplete="off"
						aria-hidden="true"
						style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }}
					/>

					<FormField
						control={form.control}
						name="email"
						render={({ field }) => (
							<FormItem>
								<FieldLabel>Company email</FieldLabel>
								<FormControl>
									<Input
										type="email"
										placeholder="you@company.com"
										autoComplete="email"
										{...field}
									/>
								</FormControl>
								<FormMessage className="text-[11px]" />
							</FormItem>
						)}
					/>

					<FormField
						control={form.control}
						name="name"
						render={({ field }) => (
							<FormItem>
								<FieldLabel>Your name</FieldLabel>
								<FormControl>
									<Input
										type="text"
										placeholder="Jordan Rivera"
										autoComplete="name"
										{...field}
									/>
								</FormControl>
								<FormMessage className="text-[11px]" />
							</FormItem>
						)}
					/>

					<FormField
						control={form.control}
						name="country"
						render={({ field, fieldState }) => (
							<FormItem>
								<FieldLabel>Country</FieldLabel>
								<FormControl>
									<CountrySelect
										value={field.value}
										onChange={field.onChange}
										invalid={!!fieldState.error}
									/>
								</FormControl>
								<FormMessage className="text-[11px]" />
							</FormItem>
						)}
					/>

					<FormField
						control={form.control}
						name="phone"
						render={({ field }) => (
							<FormItem>
								<FieldLabel optional>Phone number</FieldLabel>
								<FormControl>
									<PhoneInput
										value={field.value}
										onChange={field.onChange}
										onBlur={field.onBlur}
										defaultCountry={DEFAULT_COUNTRY}
										autoComplete="tel"
										placeholder="Enter phone number"
									/>
								</FormControl>
								<FormMessage className="text-[11px]" />
							</FormItem>
						)}
					/>

					<FormField
						control={form.control}
						name="website"
						render={({ field }) => (
							<FormItem>
								<FieldLabel optional>Company website</FieldLabel>
								<FormControl>
									<Input
										type="url"
										placeholder="https://company.com"
										style={mono}
										{...field}
									/>
								</FormControl>
								<FormMessage className="text-[11px]" />
							</FormItem>
						)}
					/>

					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
						<FormField
							control={form.control}
							name="companySize"
							render={({ field }) => (
								<FormItem>
									<FieldLabel>Company size</FieldLabel>
									<Select value={field.value} onValueChange={field.onChange}>
										<FormControl>
											<SelectTrigger className="w-full">
												<SelectValue placeholder="Select a value" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											{SIZES.map((s) => (
												<SelectItem key={s} value={s}>
													{s}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<FormMessage className="text-[11px]" />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="interest"
							render={({ field }) => (
								<FormItem>
									<FieldLabel>Primary product interest</FieldLabel>
									<Select value={field.value} onValueChange={field.onChange}>
										<FormControl>
											<SelectTrigger className="w-full">
												<SelectValue placeholder="Select a value" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											{INTERESTS.map((s) => (
												<SelectItem key={s} value={s}>
													{s}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<FormMessage className="text-[11px]" />
								</FormItem>
							)}
						/>
					</div>

					<FormField
						control={form.control}
						name="message"
						render={({ field }) => (
							<FormItem>
								<FieldLabel>How can we help?</FieldLabel>
								<FormControl>
									<Textarea
										rows={6}
										className="min-h-36"
										placeholder="Your company needs — teams, identity provider, where your data has to live."
										style={{ resize: "vertical" }}
										{...field}
									/>
								</FormControl>
								<FormMessage className="text-[11px]" />
							</FormItem>
						)}
					/>

					<FormField
						control={form.control}
						name="consent"
						render={({ field }) => (
							<FormItem>
								<label style={{ display: "flex", gap: 11, alignItems: "flex-start", cursor: "pointer", paddingTop: 2 }}>
									<input
										type="checkbox"
										checked={field.value}
										onChange={(e) => field.onChange(e.target.checked)}
										onBlur={field.onBlur}
										style={{ marginTop: 2, accentColor: "var(--text-primary)", width: 15, height: 15, flexShrink: 0 }}
									/>
									<span style={{ fontSize: 11.5, color: "var(--text-tertiary)", lineHeight: 1.55 }}>
										I agree to receive communications from Alethia Labs as
										described in the{" "}
										<Link
											href="/privacy"
											style={{ color: "var(--text-secondary)", textDecoration: "underline", textUnderlineOffset: 2 }}
										>
											Privacy Policy
										</Link>
										. I can withdraw consent at any time via the unsubscribe link
										in any email.
									</span>
								</label>
								<FormMessage className="text-[11px]" />
							</FormItem>
						)}
					/>

					<Button
						type="submit"
						size="lg"
						disabled={pending}
						style={{ width: "100%", marginTop: 4 }}
					>
						{pending ? "Sending…" : submitLabel}
						{!pending && <Icon k="arrow" size={15} />}
					</Button>
				</div>
			</form>
		</Form>
	);
}
