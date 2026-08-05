// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package tofu

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// lifecycleModule is a provider-less module (terraform_data is built into OpenTofu, so
// init needs no network) with a local backend, one variable, one resource and one
// sensitive output — enough to drive every TofuCLI lifecycle wrapper offline.
const lifecycleModule = `
terraform {
  backend "local" {}
}

variable "note" {
  type    = string
  default = "unset"
}

resource "terraform_data" "probe" {
  input = var.note
}

output "kubeconfig" {
  value     = "kube-${var.note}"
  sensitive = true
}
`

// newLifecycleWorkdir writes lifecycleModule plus a backend.hcl into a fresh temp dir and
// returns the dir and the backend file path.
func newLifecycleWorkdir(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "main.tf"), []byte(lifecycleModule), 0o600); err != nil {
		t.Fatalf("write module: %v", err)
	}
	backendFile := filepath.Join(dir, "backend.hcl")
	if err := os.WriteFile(backendFile, []byte(`path = "alethia.tfstate"`+"\n"), 0o600); err != nil {
		t.Fatalf("write backend.hcl: %v", err)
	}
	return dir, backendFile
}

// newLifecycleCLI builds a TofuCLI over dir whose lifecycle writer is the returned buffer.
func newLifecycleCLI(t *testing.T, dir string) (*TofuCLI, *bytes.Buffer) {
	t.Helper()
	var logBuf bytes.Buffer
	tf, err := NewTofuCLI(context.Background(), "", dir, &logBuf, &logBuf)
	if err != nil {
		t.Fatalf("NewTofuCLI: %v", err)
	}
	return tf, &logBuf
}

// TestTofuCLI_InitVariants covers the two init wrappers the lifecycle test does not use:
// Init (inline -backend-config pairs) and InitNoBackend (the BYO-IaC scan path).
func TestTofuCLI_InitVariants(t *testing.T) {
	requireTofuOrSkip(t)

	ctx := context.Background()

	t.Run("Init with inline backend config", func(t *testing.T) {
		dir, _ := newLifecycleWorkdir(t)
		tf, logBuf := newLifecycleCLI(t, dir)
		if err := tf.Init(ctx, map[string]string{"path": "inline.tfstate"}, true); err != nil {
			t.Fatalf("Init: %v\n%s", err, logBuf)
		}
		if _, err := os.Stat(filepath.Join(dir, ".terraform")); err != nil {
			t.Fatalf("init did not create .terraform: %v", err)
		}
	})

	t.Run("InitNoBackend skips backend configuration", func(t *testing.T) {
		dir, _ := newLifecycleWorkdir(t)
		tf, logBuf := newLifecycleCLI(t, dir)
		if err := tf.InitNoBackend(ctx); err != nil {
			t.Fatalf("InitNoBackend: %v\n%s", err, logBuf)
		}
		// -backend=false must not have written a backend state file.
		if _, err := os.Stat(filepath.Join(dir, "terraform.tfstate")); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("InitNoBackend wrote backend state: err=%v", err)
		}
		if _, err := tf.Validate(ctx); err != nil {
			t.Fatalf("Validate after InitNoBackend: %v\n%s", err, logBuf)
		}
	})
}

// TestTofuCLI_ImportRejectsIncompletePairs covers Import's guard: both halves of the
// address/id pair come from parsing a provider error, so a half-parsed pair must be
// refused before it reaches the state-mutating subprocess.
func TestTofuCLI_ImportRejectsIncompletePairs(t *testing.T) {
	tests := []struct {
		name    string
		address string
		id      string
	}{
		{name: "both empty", address: "", id: ""},
		{name: "missing address", address: "", id: "i-0123456789"},
		{name: "missing id", address: "aws_instance.web", id: ""},
		{name: "whitespace only address", address: "   ", id: "i-0123456789"},
		{name: "whitespace only id", address: "aws_instance.web", id: "\t\n"},
	}

	// A nil *tfexec.Terraform is safe here precisely because the guard must return
	// before any subprocess is built; a regression would nil-panic instead of erroring.
	cli := &TofuCLI{}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := cli.Import(context.Background(), tt.address, tt.id)
			if err == nil {
				t.Fatal("Import accepted an incomplete address/id pair")
			}
			if !strings.Contains(err.Error(), "import requires both") {
				t.Fatalf("Import error = %v, want the incomplete-pair guard", err)
			}
		})
	}
}

// TestTofuCLI_ImportUnwedgesState covers the happy path of Import plus the StateResources
// read-back that verifies it: a resource present in config but absent from state is
// exactly the wedge shape STATE_SURGERY repairs.
func TestTofuCLI_ImportUnwedgesState(t *testing.T) {
	requireTofuOrSkip(t)

	ctx := context.Background()
	dir, backendFile := newLifecycleWorkdir(t)
	tf, logBuf := newLifecycleCLI(t, dir)

	if _, err := OverrideTfvarsFromMap(dir, map[string]interface{}{"note": "imported"}); err != nil {
		t.Fatalf("OverrideTfvarsFromMap: %v", err)
	}
	if err := tf.InitWithBackendFile(ctx, backendFile, false); err != nil {
		t.Fatalf("InitWithBackendFile: %v\n%s", err, logBuf)
	}

	before, err := tf.StateResources(ctx)
	if err != nil {
		t.Fatalf("StateResources before import: %v", err)
	}
	if len(before) != 0 {
		t.Fatalf("StateResources before import = %v, want empty", before)
	}

	if err := tf.Import(ctx, "terraform_data.probe", "orphaned-cloud-id"); err != nil {
		t.Fatalf("Import: %v\n%s", err, logBuf)
	}

	after, err := tf.StateResources(ctx)
	if err != nil {
		t.Fatalf("StateResources after import: %v", err)
	}
	if len(after) != 1 || after[0] != "terraform_data.probe" {
		t.Fatalf("StateResources after import = %v, want [terraform_data.probe]", after)
	}
}
