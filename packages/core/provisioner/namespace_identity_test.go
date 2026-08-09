// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// staticIdentity returns a NamespaceIdentityProvisioner that always yields handle/err — an injected
// stub, so the per-cloud identity seam is testable without a live IAM/ARM write.
func staticIdentity(handle string, err error) NamespaceIdentityProvisioner {
	return func(context.Context, string, *types.ProjectConfig, string, string) (string, error) {
		return handle, err
	}
}

// TestProvisionAndBindNamespaceIdentityInjectedClouds covers the runner-injected identity seams
// (gcp Workload Identity, azure federated identity): a missing provisioner, a provisioning failure
// and a malformed handle must all fail closed BEFORE any kubectl annotate reaches the shell.
func TestProvisionAndBindNamespaceIdentityInjectedClouds(t *testing.T) {
	const gsa = "nsid-0123456789abcdef@acme-prod.iam.gserviceaccount.com"
	const uami = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"

	cases := []struct {
		name     string
		provider string
		identity NamespaceIdentityProvisioner
		wantErr  string
	}{
		{"gcp without an injected provisioner", "gcp", nil, "runner wiring bug"},
		{"gcp provisioning failure", "gcp", staticIdentity("", errors.New("iam denied")), "failed to provision per-namespace identity"},
		{"gcp malformed GSA email", "gcp", staticIdentity("not-an-email", nil), "malformed"},
		{"azure without an injected provisioner", "azure", nil, "runner wiring bug"},
		{"azure provisioning failure", "azure", staticIdentity("", errors.New("arm denied")), "failed to provision per-namespace identity"},
		{"azure malformed clientId", "azure", staticIdentity("not-a-guid", nil), "malformed"},
		{"unrecognized cloud fails closed", "digitalocean", nil, "not wired for provider"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetDeploySeams(t)
			executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
				t.Error("a kubectl annotate reached the shell despite a fail-closed identity")
				return nil
			}
			err := provisionAndBindNamespaceIdentity(
				context.Background(), tc.identity, tc.provider, "eu-central-1",
				&types.ProjectConfig{}, "fabric-1", "tenant-a", io.Discard, io.Discard)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want one containing %q", err, tc.wantErr)
			}
		})
	}

	t.Run("gcp binds the KSA to its GSA", func(t *testing.T) {
		resetDeploySeams(t)
		var commands []string
		executeCommand = func(cmd string, _ string, _ []string, _, _ io.Writer) error {
			commands = append(commands, cmd)
			return nil
		}
		err := provisionAndBindNamespaceIdentity(
			context.Background(), staticIdentity(gsa, nil), "gcp", "europe-west1",
			&types.ProjectConfig{}, "fabric-1", "tenant-a", io.Discard, io.Discard)
		if err != nil {
			t.Fatalf("provisionAndBindNamespaceIdentity: %v", err)
		}
		if len(commands) != 1 {
			t.Fatalf("commands = %#v, want one annotate", commands)
		}
		for _, want := range []string{
			"kubectl annotate serviceaccount default -n tenant-a",
			"iam.gke.io/gcp-service-account=" + gsa,
			"--overwrite",
		} {
			if !strings.Contains(commands[0], want) {
				t.Errorf("annotate missing %q: %s", want, commands[0])
			}
		}
	})

	t.Run("azure labels and annotates the KSA", func(t *testing.T) {
		resetDeploySeams(t)
		var commands []string
		executeCommand = func(cmd string, _ string, _ []string, _, _ io.Writer) error {
			commands = append(commands, cmd)
			return nil
		}
		err := provisionAndBindNamespaceIdentity(
			context.Background(), staticIdentity(uami, nil), "azure", "westeurope",
			&types.ProjectConfig{}, "fabric-1", "tenant-a", io.Discard, io.Discard)
		if err != nil {
			t.Fatalf("provisionAndBindNamespaceIdentity: %v", err)
		}
		if len(commands) != 2 {
			t.Fatalf("commands = %#v, want the WI label then the clientId annotation", commands)
		}
		if !strings.Contains(commands[0], "kubectl label serviceaccount default -n tenant-a azure.workload.identity/use=true") {
			t.Errorf("label command = %s", commands[0])
		}
		if !strings.Contains(commands[1], "azure.workload.identity/client-id="+uami) {
			t.Errorf("annotate command = %s", commands[1])
		}
	})

	t.Run("azure surfaces a failing label without annotating", func(t *testing.T) {
		resetDeploySeams(t)
		n := 0
		executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
			n++
			return errors.New("forbidden")
		}
		err := provisionAndBindNamespaceIdentity(
			context.Background(), staticIdentity(uami, nil), "azure", "westeurope",
			&types.ProjectConfig{}, "fabric-1", "tenant-a", io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "failed to bind namespace") {
			t.Fatalf("err = %v, want the bind failure", err)
		}
		if n != 1 {
			t.Fatalf("ran %d commands, want the annotate to be skipped after the label failed", n)
		}
	})
}

// TestBindACKNamespaceIdentity covers the Alibaba RRSA wiring: the namespace injection label THEN
// the SA role-name annotation, and the short-circuit when the label fails.
func TestBindACKNamespaceIdentity(t *testing.T) {
	resetDeploySeams(t)
	var commands []string
	executeCommand = func(cmd string, _ string, _ []string, _, _ io.Writer) error {
		commands = append(commands, cmd)
		return nil
	}
	if err := bindACKNamespaceIdentity("tenant-a", "alethia-ns-tenant-a", io.Discard, io.Discard); err != nil {
		t.Fatalf("bindACKNamespaceIdentity: %v", err)
	}
	if len(commands) != 2 {
		t.Fatalf("commands = %#v, want the ns label then the SA annotation", commands)
	}
	if !strings.Contains(commands[0], "kubectl label namespace tenant-a pod-identity.alibabacloud.com/injection=on") {
		t.Errorf("label command = %s", commands[0])
	}
	if !strings.Contains(commands[1], "pod-identity.alibabacloud.com/role-name=alethia-ns-tenant-a") {
		t.Errorf("annotate command = %s", commands[1])
	}

	resetDeploySeams(t)
	executeCommand = func(string, string, []string, io.Writer, io.Writer) error { return errors.New("nope") }
	if err := bindACKNamespaceIdentity("tenant-a", "role", io.Discard, io.Discard); err == nil {
		t.Fatal("bindACKNamespaceIdentity swallowed the label failure")
	}
}

// TestBindNamespaceIdentityAnnotatesIRSARole covers the AWS branch's annotate command shape.
func TestBindNamespaceIdentityAnnotatesIRSARole(t *testing.T) {
	resetDeploySeams(t)
	var got string
	executeCommand = func(cmd string, _ string, _ []string, _, _ io.Writer) error {
		got = cmd
		return nil
	}
	const arn = "arn:aws:iam::111122223333:role/alethia-ns-tenant-a"
	if err := bindNamespaceIdentity("tenant-a", arn, io.Discard, io.Discard); err != nil {
		t.Fatalf("bindNamespaceIdentity: %v", err)
	}
	for _, want := range []string{"kubectl annotate serviceaccount default -n tenant-a", "eks.amazonaws.com/role-arn=" + arn, "--overwrite"} {
		if !strings.Contains(got, want) {
			t.Errorf("annotate missing %q: %s", want, got)
		}
	}
}

// TestKubectlApplyManifestWritesOwnerOnlyFile pins that the rendered manifest is staged in an
// owner-only file and applied from that path — the namespace path's uniform workdir rule.
func TestKubectlApplyManifestWritesOwnerOnlyFile(t *testing.T) {
	resetDeploySeams(t)
	var mode os.FileMode
	var body string
	var got string
	executeCommand = func(cmd string, _ string, _ []string, _, _ io.Writer) error {
		got = cmd
		path := strings.TrimPrefix(cmd, "kubectl apply -f ")
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat staged manifest: %v", err)
		}
		mode = info.Mode().Perm()
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read staged manifest: %v", err)
		}
		body = string(b)
		return nil
	}
	if err := kubectlApplyManifest("kind: Namespace\n", "namespace isolation", io.Discard, io.Discard); err != nil {
		t.Fatalf("kubectlApplyManifest: %v", err)
	}
	if !strings.HasPrefix(got, "kubectl apply -f ") {
		t.Fatalf("command = %q", got)
	}
	if mode != 0o600 {
		t.Errorf("staged manifest mode = %v, want 0600", mode)
	}
	if body != "kind: Namespace\n" {
		t.Errorf("staged manifest body = %q", body)
	}
}

// TestApplyNamespaceGuardrailBundle covers both fail-closed reasons (no baked templates dir, and a
// templates dir without the bundle) plus the happy-path kubectl command.
func TestApplyNamespaceGuardrailBundle(t *testing.T) {
	t.Run("no baked templates dir", func(t *testing.T) {
		resetDeploySeams(t)
		t.Setenv("ALETHIA_ARGOCD_TEMPLATES_DIR", filepath.Join(t.TempDir(), "absent"))
		executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
			t.Error("shelled out without the baked templates")
			return nil
		}
		err := applyNamespaceGuardrailBundle("tenant-a", io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "runner image is missing its baked templates") {
			t.Fatalf("err = %v, want the missing-templates refusal", err)
		}
	})

	t.Run("templates dir without the bundle", func(t *testing.T) {
		resetDeploySeams(t)
		dir := t.TempDir()
		t.Setenv("ALETHIA_ARGOCD_TEMPLATES_DIR", dir)
		executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
			t.Error("shelled out without the guardrail bundle")
			return nil
		}
		err := applyNamespaceGuardrailBundle("tenant-a", io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "guardrail bundle not found") {
			t.Fatalf("err = %v, want the missing-bundle refusal", err)
		}
	})

	t.Run("applies the bundle into the tenant namespace", func(t *testing.T) {
		resetDeploySeams(t)
		dir := t.TempDir()
		bundle := filepath.Join(dir, "preview-guardrails")
		if err := os.MkdirAll(bundle, 0o755); err != nil {
			t.Fatal(err)
		}
		t.Setenv("ALETHIA_ARGOCD_TEMPLATES_DIR", dir)
		var got string
		executeCommand = func(cmd string, _ string, _ []string, _, _ io.Writer) error {
			got = cmd
			return nil
		}
		if err := applyNamespaceGuardrailBundle("tenant-a", io.Discard, io.Discard); err != nil {
			t.Fatalf("applyNamespaceGuardrailBundle: %v", err)
		}
		if want := "kubectl apply -n tenant-a -f " + bundle; got != want {
			t.Fatalf("command = %q, want %q", got, want)
		}
	})
}
