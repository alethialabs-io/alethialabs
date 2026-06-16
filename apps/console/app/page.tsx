"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { Header } from "@/components/landing/header";
import { Hero } from "@/components/landing/hero";
import { FeatureOverview } from "@/components/landing/feature-overview";
import { Ecosystem } from "@/components/landing/ecosystem";
import { Testimonial } from "@/components/landing/testimonial";
import { GetStarted } from "@/components/landing/get-started";
import { Footer } from "@/components/landing/footer";

export default function HomePage() {
	return (
		<div className="min-h-screen bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
			<Header />
			<Hero />
			<FeatureOverview />
			<Ecosystem />
			<Testimonial />
			<GetStarted />
			<Footer />
		</div>
	);
}
