"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@repo/ui/button";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
} from "@repo/ui/form";
import { Switch } from "@repo/ui/switch";
import { saveMyEmailPreferences } from "@/app/server/actions/email-preferences";

const schema = z.object({ product_updates: z.boolean() });
type Values = z.infer<typeof schema>;

/**
 * The optional-email switches on `/email/preferences`. Only `product_updates` exists today, and it
 * is off until the person turns it on; transactional mail is not listed because it cannot be muted.
 */
export function EmailPreferencesForm({
	initial,
	productUpdatesDescription,
}: {
	initial: Values;
	productUpdatesDescription: string;
}) {
	const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: initial });

	/** Saves the switches, then resets the form to what was saved. */
	const onSubmit = form.handleSubmit(async (values) => {
		try {
			await saveMyEmailPreferences(values);
			form.reset(values);
			toast.success("Email preferences saved");
		} catch {
			toast.error("Couldn't save your email preferences. Please try again.");
		}
	});

	return (
		<Form {...form}>
			<form onSubmit={onSubmit} className="mt-6 space-y-6">
				<FormField
					control={form.control}
					name="product_updates"
					render={({ field }) => (
						<FormItem className="flex items-start justify-between gap-4">
							<div className="space-y-1">
								<FormLabel id="email-pref-product-updates">Product updates</FormLabel>
								<FormDescription>{productUpdatesDescription}</FormDescription>
							</div>
							<FormControl>
								<Switch
									aria-labelledby="email-pref-product-updates"
									checked={field.value}
									onCheckedChange={(checked) => field.onChange(checked)}
								/>
							</FormControl>
						</FormItem>
					)}
				/>
				<Button
					type="submit"
					className="w-full"
					disabled={form.formState.isSubmitting || !form.formState.isDirty}
				>
					{form.formState.isSubmitting ? "Saving…" : "Save preferences"}
				</Button>
			</form>
		</Form>
	);
}
