"use server";

// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// app/actions/auth-actions.ts

import { createClient } from "@/lib/supabase/server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

type AuthProvider = "github" | "gitlab" | "bitbucket" | "google";

/**
 * Initiates an OAuth sign-in flow with a given provider.
 * It uses the server-side Supabase client.
 * @param provider The OAuth provider (e.g., 'github', 'google').
 * @param next Optional redirect path after successful sign-in.
 */
export async function signInWithOAuth(provider: AuthProvider, next?: string | null) {
	const origin = (await headers()).get("origin");
	let callbackUrl = `${origin}/api/auth/callback`;
	
	if (next) {
		callbackUrl = `${callbackUrl}?next=${encodeURIComponent(next)}`;
		const cookieStore = await cookies();
		cookieStore.set("auth_return_to", next, { maxAge: 60 * 10, path: "/" });
	}

	try {
		const supabase = await createClient();

		const { data, error } = await supabase.auth.signInWithOAuth({
			provider,
			options: {
				redirectTo: callbackUrl,
			},
		});

		if (error) {
			console.error("OAuth Sign-In Error:", error);
			// Throwing a new Error to be caught by the component
			throw new Error(
				`Failed to sign in with ${provider}: ${error.message}`
			);
		}

		// Supabase redirects to the provider's login page, which returns a URL in data.url
		if (data.url) {
			return redirect(data.url);
		}

		// Fallback for unexpected data structure
		throw new Error("No redirection URL received from OAuth provider.");
	} catch (err) {
		// Re-throw the error to be handled by the calling component
		throw err;
	}
}

/**
 * Initiates a magic link login for a given email.
 * @param email The user's email address.
 * @param next Optional redirect path after successful sign-in.
 */
export async function signInWithMagicLink(email: string, next?: string | null) {
	const origin = (await headers()).get("origin");
	let callbackUrl = `${origin}/api/auth/callback`;
	
	if (next) {
		callbackUrl = `${callbackUrl}?next=${encodeURIComponent(next)}`;
		const cookieStore = await cookies();
		cookieStore.set("auth_return_to", next, { maxAge: 60 * 10, path: "/" });
	}

	try {
		const supabase = await createClient();

		const { error } = await supabase.auth.signInWithOtp({
			email,
			options: {
				emailRedirectTo: callbackUrl,
			},
		});

		if (error) {
			console.error("Magic Link Sign-In Error:", error);
			throw new Error(`Failed to send magic link: ${error.message}`);
		}

		// Success: the link has been sent. The client component will handle the state update.
		return { success: true };
	} catch (err) {
		// Re-throw the error to be handled by the calling component
		throw err;
	}
}


