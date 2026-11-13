// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6599: GitOps add-on delivery pushes into the apps repo, and only a GitHub link can push. The
// console refuses the mode for an apps repo on GitLab or Bitbucket, by the repo's exact host.

import { describe, expect, it } from "vitest";
import { gitopsDeployRefusal, gitopsModeRefusal } from "@/lib/git/gitops-support";

/** A self-hosted GitLab, so the GitLab case cannot pass by matching `gitlab.com` text. */
const HOSTS = { gitlabBaseUrl: "https://code.acme.example" };

describe("gitopsModeRefusal", () => {
	it.each([
		"https://github.com/acme/apps",
		"git@github.com:acme/apps.git",
		"ssh://git@github.com/acme/apps.git",
	])("allows an apps repo on GitHub (%s)", (repo) => {
		expect(gitopsModeRefusal(repo, HOSTS)).toBeNull();
	});

	it.each([
		["https://code.acme.example/acme/apps", "GitLab"],
		["git@code.acme.example:acme/apps.git", "GitLab"],
		["https://bitbucket.org/acme/apps", "Bitbucket"],
		["git@bitbucket.org:acme/apps.git", "Bitbucket"],
	])("refuses %s, naming %s and Managed delivery", (repo, name) => {
		const refusal = gitopsModeRefusal(repo, HOSTS);
		expect(refusal).toContain("GitOps delivery works only with an apps repository on GitHub for now.");
		expect(refusal).toContain(`is on ${name}, and Alethia's ${name} connection can read repositories but cannot push to them.`);
		expect(refusal).toContain("Use Managed delivery instead.");
	});

	it.each([
		// A host that only CONTAINS a provider's name is not that provider.
		"https://github.com.evil.io/acme/apps",
		"https://evilgithub.com/acme/apps",
		"https://code.acme.example.evil.io/acme/apps",
		// gitlab.com is not the configured GitLab when a self-hosted one is set.
		"https://gitlab.com/acme/apps",
		"not a url",
	])("refuses %s, whose host is no configured provider", (repo) => {
		expect(gitopsModeRefusal(repo, HOSTS)).toContain("cannot tell which Git provider hosts");
	});

	it.each([null, undefined, "", "   "])("says nothing for an environment with no apps repo (%j)", (repo) => {
		expect(gitopsModeRefusal(repo, HOSTS)).toBeNull();
	});
});

describe("gitopsDeployRefusal", () => {
	/** A snapshot with these add-ons and apps repo. */
	function snapshot(appsRepo: string | null, addons: Array<{ id: string; mode: string }>) {
		return { repositories: { apps_destination_repo: appsRepo }, addons };
	}

	it.each([
		["https://code.acme.example/acme/apps", "GitLab"],
		["https://bitbucket.org/acme/apps", "Bitbucket"],
	])("refuses a deploy with GitOps add-ons whose apps repo is %s, naming each add-on", (repo, name) => {
		const refusal = gitopsDeployRefusal(
			snapshot(repo, [
				{ id: "loki", mode: "gitops" },
				{ id: "falco", mode: "managed" },
				{ id: "cert-manager", mode: "gitops" },
			]),
			HOSTS,
		);
		expect(refusal).toContain(`is on ${name}`);
		expect(refusal).toContain("Switch the GitOps add-ons loki, cert-manager to Managed delivery, then deploy again.");
		expect(refusal).not.toContain("falco");
	});

	it("names a single add-on in the singular", () => {
		expect(gitopsDeployRefusal(snapshot("https://bitbucket.org/acme/apps", [{ id: "loki", mode: "gitops" }]), HOSTS)).toContain(
			"Switch the GitOps add-on loki to Managed delivery",
		);
	});

	it("allows a deploy with GitOps add-ons whose apps repo is on GitHub", () => {
		expect(gitopsDeployRefusal(snapshot("https://github.com/acme/apps", [{ id: "loki", mode: "gitops" }]), HOSTS)).toBeNull();
	});

	it.each(["https://code.acme.example/acme/apps", "https://bitbucket.org/acme/apps"])(
		"allows a deploy with only Managed add-ons on %s: nothing is pushed",
		(repo) => {
			expect(gitopsDeployRefusal(snapshot(repo, [{ id: "loki", mode: "managed" }]), HOSTS)).toBeNull();
			expect(gitopsDeployRefusal({ repositories: { apps_destination_repo: repo } }, HOSTS)).toBeNull();
		},
	);

	it("allows a deploy with GitOps add-ons and no apps repo, which writes nothing", () => {
		expect(gitopsDeployRefusal(snapshot(null, [{ id: "loki", mode: "gitops" }]), HOSTS)).toBeNull();
	});
});
