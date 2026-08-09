// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestInstallArgoCDRefusesShellMetacharactersInDomainName is #2013's repro, kept.
//
// `vc.DNS.DomainName` is free-text project data that reaches a `bash -c` string as the ArgoCD
// ingress hostname. Before the fix, a domain carrying a single quote closed the quote the format
// string opened and executed an arbitrary command with the runner's ambient cloud credentials, the
// per-job tofu state token, the git token and the cluster kubeconfig.
//
// The assertion is deliberately end-to-end rather than a string match on the built command: it runs
// exactly what the deploy would have handed to utils.ExecuteCommand, and fails if the payload's
// side effect is observable. A test that only grepped for quotes would pass against an escaping
// scheme that is subtly wrong.
func TestInstallArgoCDRefusesShellMetacharactersInDomainName(t *testing.T) {
	resetDeploySeams(t)

	work := t.TempDir()
	marker := filepath.Join(work, "PWNED")

	// A fake `helm`/`kubectl` so a captured command can be executed without reaching the network.
	bin := t.TempDir()
	for _, tool := range []string{"helm", "kubectl"} {
		if err := os.WriteFile(filepath.Join(bin, tool), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	executeCommandWithOutput = func(string, string, []string) (string, error) {
		return "existing-auth", nil
	}
	var commands []string
	executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
		commands = append(commands, command)
		return nil
	}

	vc := &types.ProjectConfig{
		DNS: types.ProjectDNSConfig{
			Enabled: true,
			// Hostile project data: closes the shell quote the format string opened.
			DomainName: "example.com'; touch " + marker + "; echo '",
		},
	}
	outputs := map[string]interface{}{"acm_certificate_arn": "arn:aws:acm:eu-central-1:1:certificate/1"}

	err := installArgoCD(context.Background(), vc, outputs, &PlanResult{}, io.Discard, io.Discard)

	// Fail closed: the domain is refused at the boundary, so no ingress command is ever built.
	if err == nil {
		t.Fatal("installArgoCD accepted a domain name carrying shell metacharacters; want a refusal")
	}
	if !strings.Contains(err.Error(), "not a valid DNS domain") {
		t.Fatalf("refused, but not for the reason we mean to test: %v", err)
	}

	// Belt and braces: whatever DID get built must not execute the payload. This catches a future
	// refactor that drops the validator and leans on quoting alone — the quoting has to hold too.
	for _, c := range commands {
		if strings.Contains(c, "server.ingress") {
			if runErr := exec.Command("bash", "-c", c).Run(); runErr != nil {
				t.Logf("stub exit: %v", runErr)
			}
		}
	}
	if _, statErr := os.Stat(marker); statErr == nil {
		t.Fatalf("COMMAND INJECTION: the domain name's payload executed — %s was created", marker)
	}
}

// TestInstallArgoCDQuotesTheIngressPairs pins the quoting itself, independently of the validator.
//
// Without this, deleting utils.ShellQuote from the three `--set` pairs would leave the test above
// green — it is the validator that refuses the hostile input there. The two together are what make
// the defence actually layered rather than nominally so.
func TestInstallArgoCDQuotesTheIngressPairs(t *testing.T) {
	resetDeploySeams(t)

	executeCommandWithOutput = func(string, string, []string) (string, error) {
		return "existing-auth", nil
	}
	var commands []string
	executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
		commands = append(commands, command)
		return nil
	}

	vc := &types.ProjectConfig{
		DNS: types.ProjectDNSConfig{Enabled: true, DomainName: "example.com"},
	}
	// A WAF ARN as well, so all three interpolations are exercised. These arrive from tofu outputs,
	// a trust path the domain validator never sees — which is why they are quoted at all.
	outputs := map[string]interface{}{
		"acm_certificate_arn": "arn:aws:acm:eu-central-1:1:certificate/1",
		"waf_webacl_arn":      "arn:aws:wafv2:eu-central-1:1:regional/webacl/x/1",
	}
	if err := installArgoCD(context.Background(), vc, outputs, &PlanResult{}, io.Discard, io.Discard); err != nil {
		t.Fatalf("installArgoCD: %v", err)
	}

	install := commands[len(commands)-1]
	for _, want := range []string{
		"--set 'server.ingress.hostname=argocd.example.com'",
		`--set 'server.ingress.annotations.alb\.ingress\.kubernetes\.io/certificate-arn=arn:aws:acm:eu-central-1:1:certificate/1'`,
		`--set 'server.ingress.annotations.alb\.ingress\.kubernetes\.io/wafv2-acl-arn=arn:aws:wafv2:eu-central-1:1:regional/webacl/x/1'`,
	} {
		if !strings.Contains(install, want) {
			t.Errorf("install command is missing the quoted pair\n  want substring: %s\n  got: %s", want, install)
		}
	}
}

func TestIsValidDNSDomain(t *testing.T) {
	valid := []string{
		"example.com",
		"argocd.example.com",
		"a.b.c.d.example.co.uk",
		"EXAMPLE.com",             // DNS is case-insensitive and the console does not normalise
		"xn--80ak6aa92e.com",      // punycode is plain LDH
		"my-project-1.example.io", // hyphens inside a label
		"localhost",               // a single label is a legitimate internal name
		"example.com.",            // one trailing dot = the root label; gcp/modules/cloud-dns takes this shape
		strings.Repeat("a", 63) + ".com",
	}
	for _, s := range valid {
		if !isValidDNSDomain(s) {
			t.Errorf("isValidDNSDomain(%q) = false, want true", s)
		}
	}

	invalid := []string{
		"",
		".",                                      // the root zone alone: nothing is left once the root dot is trimmed
		"..",                                     // and trimming only ONE dot still leaves an empty label
		"example.com'; touch /tmp/PWNED; echo '", // #2013's payload
		"example.com; rm -rf /",
		"example.com$(id)",
		"example.com`id`",
		"example.com\nnextline",
		"example.com |& cat",
		"exa mple.com",  // a space would split the --set pair into two words
		"-example.com",  // hyphen-bounded label
		"example-.com",  //
		".example.com",  // empty leading label
		"example.com..", // only ONE root dot is tolerated; the second leaves an empty label
		"example..com",  // doubled dot
		"exa_mple.com",  // underscore is not LDH
		"*.example.com", // wildcards are not a hostname
		"exam#ple.com",
		strings.Repeat("a", 64) + ".com", // label over 63
		strings.Repeat("a.", 127) + strings.Repeat("a", 64), // over 253 total
	}
	for _, s := range invalid {
		if isValidDNSDomain(s) {
			t.Errorf("isValidDNSDomain(%q) = true, want false (must fail closed)", s)
		}
	}
}
