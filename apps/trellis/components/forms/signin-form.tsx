"use client";

import type React from "react";

import {
	signInWithMagicLink,
	signInWithOAuth,
} from "@/app/(public)/auth/signin/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Boxes, GitBranch, Github, Mail } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

type AuthProvider = "github" | "gitlab" | "bitbucket" | "google";

export function SignInForm() {
	const [isLoading, setIsLoading] = useState(false);
	const [email, setEmail] = useState("");
	const [emailSent, setEmailSent] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const router = useRouter();
	const searchParams = useSearchParams();
	const next = searchParams.get("next");

	const handleMagicLinkLogin = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsLoading(true);
		setError(null);

		try {
			await signInWithMagicLink(email, next);
			setEmailSent(true);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to send magic link"
			);
		} finally {
			setIsLoading(false);
		}
	};

	const handleOAuthLogin = async (provider: AuthProvider) => {
		setIsLoading(true);
		setError(null);

		try {
			await signInWithOAuth(provider, next);
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: `Failed to sign in with ${provider}`
			);
			setIsLoading(false);
		}
	};

	if (emailSent) {
		return (
			<div className="text-center space-y-6">
				<div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto border border-border">
					<Mail className="w-5 h-5 text-foreground" />
				</div>
				<div className="space-y-2">
					<h3 className="text-lg font-medium text-foreground tracking-tight">
						Check your email
					</h3>
					<p className="text-sm text-muted-foreground">
						We sent a magic link to{" "}
						<span className="font-medium text-foreground">{email}</span>
					</p>
					<p className="text-xs text-muted-foreground pt-2">
						Click the link in the email to sign in automatically.
					</p>
				</div>
				<Button
					variant="outline"
					onClick={() => {
						setEmailSent(false);
						setEmail("");
					}}
					className="w-full"
				>
					Back to login
				</Button>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{error && (
				<div className="bg-destructive/10 border border-destructive/20 text-destructive px-4 py-3 rounded-md text-sm">
					{error}
				</div>
			)}

			<form onSubmit={handleMagicLinkLogin} className="space-y-4">
				<div className="space-y-2">
					<Label htmlFor="email" className="sr-only">Email</Label>
					<Input
						id="email"
						type="email"
						placeholder="name@example.com"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						required
						disabled={isLoading}
						className="h-10 transition-colors focus-visible:ring-1"
					/>
				</div>

				<Button
					type="submit"
					disabled={isLoading || !email}
					className="w-full h-10 font-medium"
				>
					{isLoading ? "Sending link..." : "Continue with Email"}
				</Button>
			</form>

			<div className="relative">
				<div className="absolute inset-0 flex items-center">
					<Separator className="w-full" />
				</div>
				<div className="relative flex justify-center text-xs uppercase">
					<span className="bg-card px-2 text-muted-foreground">
						Or continue with
					</span>
				</div>
			</div>

			<div className="space-y-3">
				<Button
					onClick={() => handleOAuthLogin("google")}
					disabled={isLoading}
					variant="outline"
					className="w-full h-10 font-normal hover:bg-muted/50 transition-colors"
				>
					<Mail className="w-4 h-4 mr-2" />
					Google
				</Button>

				<Button
					onClick={() => handleOAuthLogin("github")}
					disabled={isLoading}
					variant="outline"
					className="w-full h-10 font-normal hover:bg-muted/50 transition-colors"
				>
					<Github className="w-4 h-4 mr-2" />
					GitHub
				</Button>

				<Button
					onClick={() => handleOAuthLogin("gitlab")}
					disabled={isLoading}
					variant="outline"
					className="w-full h-10 font-normal hover:bg-muted/50 transition-colors"
				>
					<GitBranch className="w-4 h-4 mr-2" />
					GitLab
				</Button>

				<Button
					onClick={() => handleOAuthLogin("bitbucket")}
					disabled={isLoading}
					variant="outline"
					className="w-full h-10 font-normal hover:bg-muted/50 transition-colors"
				>
					<Boxes className="w-4 h-4 mr-2" />
					Bitbucket
				</Button>
			</div>

			<div className="text-center pt-2">
				<p className="text-sm text-muted-foreground">
					Don&apos;t have an account?{" "}
					<button
						type="button"
						className="text-foreground hover:underline font-medium underline-offset-4 transition-colors"
						onClick={() => router.push("/contact")}
					>
						Contact sales
					</button>
				</p>
			</div>
		</div>
	);
}