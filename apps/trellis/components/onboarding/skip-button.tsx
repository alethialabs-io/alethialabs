"use client";

import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";

export function SkipButton() {
	const router = useRouter();

	const handleSkip = () => {
		// Mark onboarding as skipped in local storage to prevent auto-redirect loop
		localStorage.setItem("aws_onboarding_skipped", "true");
		router.push("/dashboard");
	};

	return (
		<Button
			variant="ghost"
			onClick={handleSkip}
			className="text-muted-foreground hover:text-foreground text-xs font-medium h-8 px-3 transition-colors"
		>
			Skip for now
			<ArrowRight className="ml-1.5 w-3 h-3 opacity-70" />
		</Button>
	);
}
