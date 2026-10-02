// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	talosconfig "github.com/siderolabs/talos/pkg/machinery/client/config"
)

// TestAssertSafeTalosEndpoints locks the SSRF guard (runner-parent-ssrf rule): a link-local (cloud
// metadata) / loopback / unspecified endpoint from a customer-influenced talosconfig must be refused
// before the trusted runner dials, while public and private (self-hosted) control-plane IPs pass.
func TestAssertSafeTalosEndpoints(t *testing.T) {
	mk := func(eps ...string) *talosconfig.Config {
		return &talosconfig.Config{
			Context:  "c",
			Contexts: map[string]*talosconfig.Context{"c": {Endpoints: eps}},
		}
	}

	reject := map[string]*talosconfig.Config{
		"link-local cloud metadata": mk("169.254.169.254"),
		"link-local with port":      mk("169.254.169.254:50000"),
		"loopback":                  mk("127.0.0.1:50000"),
		"unspecified":               mk("0.0.0.0"),
		"empty endpoints":           mk(),
		"missing active context":    {Context: "missing", Contexts: map[string]*talosconfig.Context{}},
		"one bad among good":        mk("203.0.113.10", "169.254.169.254"),
	}
	for name, cfg := range reject {
		if err := assertSafeTalosEndpoints(cfg); err == nil {
			t.Errorf("%s: expected rejection, got nil", name)
		}
	}

	allow := map[string]*talosconfig.Config{
		"public ip":           mk("203.0.113.10"),
		"public ip with port": mk("203.0.113.10:50000"),
		"private rfc1918":     mk("10.0.0.5"), // self-hosted private control plane is legitimate
		"private 172.16":      mk("172.16.4.4:50000"),
	}
	for name, cfg := range allow {
		if err := assertSafeTalosEndpoints(cfg); err != nil {
			t.Errorf("%s: expected pass, got %v", name, err)
		}
	}
}

// TestMintFromTalosconfigKeepsTheSSRFGuard pins that the dedicated-job minter (#5330) is the guarded
// MintTalosKubeconfig, not a second dial path: a talosconfig read from a state's outputs is as
// customer-influenced as a persisted one, so one pointing at cloud metadata or loopback is refused
// before any dial, and an empty one is refused rather than minting nothing.
func TestMintFromTalosconfigKeepsTheSSRFGuard(t *testing.T) {
	mk := func(ep string) string {
		return "context: c\ncontexts:\n  c:\n    endpoints:\n      - " + ep + "\n"
	}
	for name, tc := range map[string]string{
		"cloud metadata": mk("169.254.169.254"),
		"loopback":       mk("127.0.0.1:50000"),
	} {
		_, err := mintFromTalosconfig(context.Background(), tc)
		if err == nil || !strings.Contains(err.Error(), "SSRF guard") {
			t.Errorf("%s: want the SSRF guard's refusal, got %v", name, err)
		}
	}
	if _, err := mintFromTalosconfig(context.Background(), "  "); err == nil || !strings.Contains(err.Error(), "empty talosconfig") {
		t.Errorf("an empty talosconfig must be refused, got %v", err)
	}
}

// TestRunTalosKubeconfigIsTheGuardedMint pins the `talos-kubeconfig` subcommand (#5339) end to end
// through the exported entry point the table dispatches: the talosconfig is read from the process's
// stdin and handed to MintTalosKubeconfig, so a talosconfig pointing at cloud metadata is refused by
// the SSRF guard before any dial, and nothing is written to stdout.
func TestRunTalosKubeconfigIsTheGuardedMint(t *testing.T) {
	const metadata = "context: c\ncontexts:\n  c:\n    endpoints:\n      - 169.254.169.254\n"
	dir := t.TempDir()
	in, err := os.Create(filepath.Join(dir, "stdin"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := in.WriteString(metadata); err != nil {
		t.Fatal(err)
	}
	if _, err := in.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	out, err := os.Create(filepath.Join(dir, "stdout"))
	if err != nil {
		t.Fatal(err)
	}
	prevIn, prevOut := os.Stdin, os.Stdout
	os.Stdin, os.Stdout = in, out
	err = RunTalosKubeconfig(context.Background(), nil)
	os.Stdin, os.Stdout = prevIn, prevOut
	_ = in.Close()
	_ = out.Close()

	if err == nil || !strings.Contains(err.Error(), "SSRF guard") {
		t.Fatalf("want the SSRF guard's refusal, got %v", err)
	}
	if written, _ := os.ReadFile(filepath.Join(dir, "stdout")); len(written) != 0 {
		t.Fatalf("a refused mint wrote %d bytes to stdout", len(written))
	}
}

// TestRunTalosKubeconfigReadsStdinAndWritesStdout pins the subcommand's contract with its caller:
// stdin is the talosconfig, verbatim; stdout is the kubeconfig, verbatim; arguments and an oversize
// input are refused before the minter is called; a mint error is returned and writes nothing.
func TestRunTalosKubeconfigReadsStdinAndWritesStdout(t *testing.T) {
	var got string
	calls := 0
	mint := func(_ context.Context, tc string) ([]byte, error) {
		calls++
		got = tc
		return []byte("apiVersion: v1\nkind: Config\n"), nil
	}

	var out strings.Builder
	if err := runTalosKubeconfig(context.Background(), nil, strings.NewReader("talosconfig-yaml"), &out, mint); err != nil {
		t.Fatal(err)
	}
	if got != "talosconfig-yaml" {
		t.Errorf("the minter was handed %q, want stdin verbatim", got)
	}
	if out.String() != "apiVersion: v1\nkind: Config\n" {
		t.Errorf("stdout = %q, want the minted kubeconfig verbatim", out.String())
	}

	calls = 0
	if err := runTalosKubeconfig(context.Background(), []string{"talosconfig-yaml"}, strings.NewReader(""), &out, mint); err == nil {
		t.Error("an argument must be refused: a talosconfig on argv is visible in a process listing")
	}
	big := strings.Repeat("x", maxTalosconfigStdinBytes+1)
	if err := runTalosKubeconfig(context.Background(), nil, strings.NewReader(big), &out, mint); err == nil {
		t.Error("a talosconfig over the console's size cap must be refused")
	}
	if calls != 0 {
		t.Errorf("the minter was called %d time(s) for a refused input", calls)
	}

	out.Reset()
	failing := func(context.Context, string) ([]byte, error) { return nil, errors.New("apid unreachable") }
	if err := runTalosKubeconfig(context.Background(), nil, strings.NewReader("x"), &out, failing); err == nil || !strings.Contains(err.Error(), "apid unreachable") {
		t.Errorf("a mint error must be returned as it is, got %v", err)
	}
	if out.Len() != 0 {
		t.Errorf("a failed mint wrote %q to stdout", out.String())
	}
}
