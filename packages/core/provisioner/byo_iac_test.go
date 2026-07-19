// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// gitInitModuleRepo builds a git repo containing a module directory `module/`
// whose main.tf is `mainTF`, and returns (repoDir, branch, commitSHA).
func gitInitModuleRepo(t *testing.T, mainTF string) (string, string, string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	repo := t.TempDir()
	run := func(args ...string) string {
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e.com",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e.com",
			"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("init", "-q")
	if err := os.MkdirAll(filepath.Join(repo, "module"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "module", "main.tf"), []byte(mainTF), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-q", "-m", "module")
	sha := run("rev-parse", "HEAD")
	branch := run("rev-parse", "--abbrev-ref", "HEAD")
	return repo, branch, sha
}

const validModuleTF = `resource "null_resource" "x" {}
`

// local-exec provisioner → iacsafety RuleProvisionerBlock (error) → gate blocks.
const evilModuleTF = `resource "null_resource" "x" {
  provisioner "local-exec" {
    command = "echo pwned > /tmp/pwned"
  }
}
`

// TestPrepareByoIacWorkdir_ValidModule asserts a clean provider-less module clones,
// passes the inline gate, and yields the module dir + backend override + coerced tfvars.
func TestPrepareByoIacWorkdir_ValidModule(t *testing.T) {
	allowInsecureRepoURLForTest = true
	defer func() { allowInsecureRepoURLForTest = false }()
	repo, branch, sha := gitInitModuleRepo(t, validModuleTF)

	vc := &types.ProjectConfig{
		ID:               "cfg-123",
		ProjectName:      "acme",
		EnvironmentStage: "prod",
		Region:           "eu-central-1",
		FabricID:         "fab-1", // #839: BYO-IaC attaches at the Fabric — exposed in the TF_VAR contract.
		IacSource: &types.ProjectIacSourceConfig{
			RepoURL:   "file://" + repo,
			Ref:       branch,
			CommitSHA: sha,
			Path:      "module",
			VarValues: map[string]any{
				"instance_count":     float64(3),
				"name":               "web",
				"enabled":            true,
				"tags":               map[string]any{"team": "x"}, // rejected (object)
				"alethia_project_id": "spoofed",                   // rejected (reserved namespace)
			},
		},
	}

	var out, errBuf bytes.Buffer
	cloneDir := filepath.Join(t.TempDir(), "clone")
	tfDir, tfvars, restore, err := prepareByoIacWorkdir(vc, "", cloneDir, &out, &errBuf)
	if err != nil {
		t.Fatalf("prepareByoIacWorkdir: %v\nstderr:%s", err, errBuf.String())
	}
	defer restore()

	// tfDir is the module dir inside the clone.
	if filepath.Base(tfDir) != "module" {
		t.Fatalf("tfDir = %q, want .../module", tfDir)
	}
	if _, statErr := os.Stat(filepath.Join(tfDir, "main.tf")); statErr != nil {
		t.Fatalf("module main.tf missing in workdir: %v", statErr)
	}

	// Backend override written under BOTH extensions (.tf + .tofu) so a customer
	// `*.tofu` override cannot outrank + shadow the platform `.tf` override.
	for _, name := range []string{byoBackendOverrideFile, byoBackendOverrideFileTofu} {
		if _, statErr := os.Stat(filepath.Join(tfDir, name)); statErr != nil {
			t.Fatalf("backend override %s not written: %v", name, statErr)
		}
	}

	// Scalar var_values pass; object is dropped.
	if tfvars["instance_count"] != float64(3) || tfvars["name"] != "web" || tfvars["enabled"] != true {
		t.Fatalf("scalar var_values not coerced through: %#v", tfvars)
	}
	if _, ok := tfvars["tags"]; ok {
		t.Fatalf("object var_value should have been rejected, got: %#v", tfvars["tags"])
	}
	// The reserved alethia_ key must never reach the tfvars (it would override the
	// frozen TF_VAR_alethia_* platform context via -var-file precedence).
	if _, ok := tfvars["alethia_project_id"]; ok {
		t.Fatalf("reserved alethia_ var_value reached tfvars: %#v", tfvars["alethia_project_id"])
	}

	// Frozen TF_VAR contract is published.
	for k, want := range map[string]string{
		"TF_VAR_alethia_project":        "acme",
		"TF_VAR_alethia_environment":    "prod",
		"TF_VAR_alethia_region":         "eu-central-1",
		"TF_VAR_alethia_project_id":     "cfg-123",
		"TF_VAR_alethia_environment_id": "cfg-123",
		"TF_VAR_alethia_fabric_id":      "fab-1",
	} {
		if got := os.Getenv(k); got != want {
			t.Fatalf("%s = %q, want %q", k, got, want)
		}
	}

	// restore() unsets them.
	restore()
	if v, ok := os.LookupEnv("TF_VAR_alethia_project"); ok {
		t.Fatalf("restore did not unset TF_VAR_alethia_project (=%q)", v)
	}
}

// TestPrepareByoIacWorkdir_EvilModuleBlocks asserts the inline gate fails closed on
// a module with a provisioner (code execution) BEFORE any workdir is returned.
func TestPrepareByoIacWorkdir_EvilModuleBlocks(t *testing.T) {
	allowInsecureRepoURLForTest = true
	defer func() { allowInsecureRepoURLForTest = false }()
	repo, branch, sha := gitInitModuleRepo(t, evilModuleTF)
	vc := &types.ProjectConfig{
		ProjectName: "acme", EnvironmentStage: "prod", Region: "eu",
		IacSource: &types.ProjectIacSourceConfig{
			RepoURL: "file://" + repo, Ref: branch, CommitSHA: sha, Path: "module",
		},
	}
	var out, errBuf bytes.Buffer
	cloneDir := filepath.Join(t.TempDir(), "clone")
	_, _, restore, err := prepareByoIacWorkdir(vc, "", cloneDir, &out, &errBuf)
	if err == nil {
		if restore != nil {
			restore()
		}
		t.Fatal("expected the inline iacsafety gate to BLOCK a provisioner module, got nil error")
	}
	if !strings.Contains(err.Error(), "static gate BLOCKED") {
		t.Fatalf("error should name the fail-closed gate, got: %v", err)
	}
	// The gate must fire before the TF_VAR contract is published.
	if _, ok := os.LookupEnv("TF_VAR_alethia_project"); ok {
		t.Fatal("TF_VAR_alethia_project leaked despite a blocked module")
	}
}

// TestPrepareByoIacWorkdir_RequiresCommitSHA asserts a ref-only source is rejected.
func TestPrepareByoIacWorkdir_RequiresCommitSHA(t *testing.T) {
	allowInsecureRepoURLForTest = true
	defer func() { allowInsecureRepoURLForTest = false }()
	vc := &types.ProjectConfig{
		IacSource: &types.ProjectIacSourceConfig{RepoURL: "file:///x", Ref: "main"},
	}
	_, _, _, err := prepareByoIacWorkdir(vc, "", t.TempDir(), &bytes.Buffer{}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "commit_sha") {
		t.Fatalf("expected a missing commit_sha error, got: %v", err)
	}
}

// TestPrepareByoIacWorkdir_RejectsFileURLInProd asserts that WITHOUT the test
// escape (i.e. production), a file:// RepoURL is rejected before any clone — the
// untrusted path must never clone an on-box repository.
func TestPrepareByoIacWorkdir_RejectsFileURLInProd(t *testing.T) {
	// allowInsecureRepoURLForTest defaults to false (production posture).
	vc := &types.ProjectConfig{
		IacSource: &types.ProjectIacSourceConfig{
			RepoURL:   "file:///etc/on-box-repo",
			Ref:       "main",
			CommitSHA: strings.Repeat("a", 40),
			Path:      "module",
		},
	}
	_, _, _, err := prepareByoIacWorkdir(vc, "", t.TempDir(), &bytes.Buffer{}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "https or ssh") {
		t.Fatalf("expected a file:// RepoURL to be rejected in production, got: %v", err)
	}
	// https / ssh / scp-like transports pass validation.
	for _, ok := range []string{"https://github.com/o/r.git", "ssh://git@github.com/o/r.git", "git@github.com:o/r.git"} {
		if verr := validateByoRepoURL(ok); verr != nil {
			t.Fatalf("validateByoRepoURL(%q) = %v, want nil", ok, verr)
		}
	}
	if verr := validateByoRepoURL("file:///x"); verr == nil {
		t.Fatal("validateByoRepoURL(file://) should fail in production mode")
	}
}

// TestResolveByoModuleDir covers path resolution + traversal containment. The
// returned path is symlink-resolved, so expectations are compared against the
// EvalSymlinks form of the clone (t.TempDir on macOS lives under a /var → /private
// symlink).
func TestResolveByoModuleDir(t *testing.T) {
	clone := t.TempDir()
	if err := os.MkdirAll(filepath.Join(clone, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	realClone, err := filepath.EvalSymlinks(clone)
	if err != nil {
		t.Fatal(err)
	}

	// Root path resolves to the (symlink-resolved) clone.
	if got, err := resolveByoModuleDir(clone, ""); err != nil || got != realClone {
		t.Fatalf("root path: got %q err %v, want %q", got, err, realClone)
	}
	// Subdir resolves.
	if got, err := resolveByoModuleDir(clone, "sub"); err != nil || got != filepath.Join(realClone, "sub") {
		t.Fatalf("subdir: got %q err %v", got, err)
	}
	// `..` escape is clamped by Clean("/"+path) and lands as a missing dir under the clone.
	if _, err := resolveByoModuleDir(clone, "../../etc"); err == nil {
		t.Fatal("expected an escape/not-found error for a `..` path")
	}
	// A non-existent subdir is rejected.
	if _, err := resolveByoModuleDir(clone, "nope"); err == nil {
		t.Fatal("expected not-found for a missing module path")
	}
}

// TestResolveByoModuleDir_SymlinkEscape asserts a repo-committed symlink that
// points OUTSIDE the clone is rejected — the lexical check passes (the link name
// is inside the clone) but the symlink-resolved containment check catches it.
func TestResolveByoModuleDir_SymlinkEscape(t *testing.T) {
	base := t.TempDir()
	clone := filepath.Join(base, "clone")
	outside := filepath.Join(base, "outside")
	if err := os.MkdirAll(clone, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	// `clone/evil -> ../outside` — lexically inside the clone, really outside it.
	if err := os.Symlink(outside, filepath.Join(clone, "evil")); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	got, err := resolveByoModuleDir(clone, "evil")
	if err == nil {
		t.Fatalf("expected symlink escape to be rejected, got moduleDir %q", got)
	}
	if !strings.Contains(err.Error(), "outside the repository clone") {
		t.Fatalf("error should name the containment escape, got: %v", err)
	}
}

// TestCoerceByoVarValues covers the scalar allow / structured reject rules.
func TestCoerceByoVarValues(t *testing.T) {
	in := map[string]any{
		"s":                  "str",
		"n":                  float64(2),
		"i":                  7,
		"b":                  false,
		"nul":                nil,
		"obj":                map[string]any{"a": 1},
		"list":               []any{"a", "b"},
		"alethia_project_id": "spoofed", // reserved namespace (even though scalar)
		"alethia_region":     "spoofed",
	}
	out := coerceByoVarValues(in, &bytes.Buffer{}, &bytes.Buffer{})
	for _, k := range []string{"s", "n", "i", "b"} {
		if _, ok := out[k]; !ok {
			t.Fatalf("scalar %q was dropped", k)
		}
	}
	for _, k := range []string{"nul", "obj", "list"} {
		if _, ok := out[k]; ok {
			t.Fatalf("non-scalar %q should have been rejected", k)
		}
	}
	// Reserved alethia_ keys are dropped even though they are scalars — they must
	// never win the -var-file vs TF_VAR_alethia_* precedence race.
	for _, k := range []string{"alethia_project_id", "alethia_region"} {
		if _, ok := out[k]; ok {
			t.Fatalf("reserved %q should have been dropped", k)
		}
	}
}
