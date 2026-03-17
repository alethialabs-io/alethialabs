import { SignInForm } from "@/components/forms/signin-form";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

export default function SignInPage() {
	return (
		<div className="min-h-screen bg-background flex flex-col justify-center py-12 sm:px-6 lg:px-8">
			<div className="absolute top-8 left-8">
				<Link
					href="/"
					className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
				>
					<ArrowLeft className="w-4 h-4" />
					Back to home
				</Link>
			</div>

			<div className="sm:mx-auto sm:w-full sm:max-w-md text-center">
				<div className="flex justify-center mb-6">
					<div className="flex items-center space-x-3">
						<img
							src="/itgix-favicon-32x32.png"
							alt="ItGix Logo"
							className="w-8 h-8 grayscale opacity-90"
						/>
						<span className="font-semibold text-xl tracking-tight text-foreground">
							Trellis
						</span>
					</div>
				</div>
				<h2 className="text-2xl font-semibold tracking-tight text-foreground">
					Log in to your account
				</h2>
				<p className="mt-2 text-sm text-muted-foreground">
					Welcome back! Please enter your details.
				</p>
			</div>

			<div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
				<div className="bg-card py-8 px-4 shadow-sm sm:rounded-xl sm:px-10 border border-border/50">
					<SignInForm />
				</div>
				
				<p className="text-center text-xs text-muted-foreground mt-8">
					By signing in, you agree to our{" "}
					<Link
						href="/terms"
						className="underline underline-offset-4 hover:text-foreground transition-colors"
					>
						Terms of Service
					</Link>{" "}
					and{" "}
					<Link
						href="/privacy"
						className="underline underline-offset-4 hover:text-foreground transition-colors"
					>
						Privacy Policy
					</Link>
				</p>
			</div>
		</div>
	);
}
