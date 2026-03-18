import { createClient } from "@/lib/supabase/server";
import { saveProviderToken } from "@/app/server/actions/identities";
import { PublicGitProvider } from "@/lib/validations/db.schemas";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
	const { searchParams, origin } = new URL(request.url);
	const code = searchParams.get("code");
	
	const cookieStore = await cookies();
	const nextCookie = cookieStore.get("auth_return_to")?.value;
	
	// if "next" is in param, use it as the redirect target, fallback to cookie
	const next = searchParams.get("next") ?? nextCookie ?? "/dashboard/profile";
	const providerParam = searchParams.get("provider");
	
	if (code) {
		const supabase = await createClient();
		const { data, error } =
			await supabase.auth.exchangeCodeForSession(code);

		if (!error && data?.session) {
			// Clear the return-to cookie if it was used
			if (nextCookie) {
				cookieStore.delete("auth_return_to");
			}

			const { session } = data;
			const providerToken = session.provider_token;
			const refreshToken = session.provider_refresh_token;

			let provider = providerParam;
			if (!provider && session.user.app_metadata?.provider) {
				provider = session.user.app_metadata.provider;
			}

			// Capture and save the provider token since Supabase does not store it in the DB
			if (provider && ['github', 'gitlab', 'bitbucket'].includes(provider) && providerToken) {
				try {
					await saveProviderToken(
						provider as PublicGitProvider,
						providerToken,
						refreshToken || undefined
					);
					console.log(`[Auth Callback] Successfully saved token for ${provider}`);
				} catch (saveError) {
					console.error("[Auth Callback] Error saving provider token via action:", saveError);
				}
			}

			const forwardedHost = request.headers.get("x-forwarded-host"); // original origin before load balancer
			const isLocalEnv = process.env.NODE_ENV === "development";

			if (isLocalEnv) {
				// we can be sure that there is no load balancer in between, so no need to watch for X-Forwarded-Host
				return NextResponse.redirect(`${origin}${next}`);
			} else if (forwardedHost) {
				return NextResponse.redirect(`https://${forwardedHost}${next}`);
			} else {
				return NextResponse.redirect(`${origin}${next}`);
			}
		}
	}

	// return the user to an error page with instructions
	return NextResponse.redirect(`${origin}/auth/auth-code-error`);
}
