// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package iacsafety

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

// findingKeys reduces a report's findings to a sorted "severity:rule" multiset
// for table-driven comparison.
func findingKeys(r *Report) []string {
	out := make([]string, 0, len(r.Findings))
	for _, f := range r.Findings {
		out = append(out, f.Severity+":"+f.Rule)
	}
	sort.Strings(out)
	return out
}

// TestScanFixtures runs the policy over every checked-in fixture module and
// asserts the exact finding multiset, providers, modules, and OK verdict.
func TestScanFixtures(t *testing.T) {
	cases := []struct {
		name          string
		allowlist     []string
		wantOK        bool
		wantFindings  []string // sorted "severity:rule"
		wantProviders []string
		wantModules   []string
	}{
		{
			name:          "clean",
			wantOK:        true,
			wantFindings:  []string{},
			wantProviders: []string{"hashicorp/aws"},
			wantModules:   []string{},
		},
		{
			name:   "provisioner",
			wantOK: false,
			wantFindings: []string{
				"error:provisioner-block",
				"error:provisioner-block",
			},
			wantProviders: []string{"hashicorp/aws"},
			wantModules:   []string{},
		},
		{
			name:          "provattr",
			wantOK:        false,
			wantFindings:  []string{"error:provisioner-block"},
			wantProviders: []string{},
			wantModules:   []string{},
		},
		{
			name:   "external",
			wantOK: false,
			wantFindings: []string{
				"error:external-data-source",
				"error:provider-not-allowlisted",
			},
			wantProviders: []string{"hashicorp/external"},
			wantModules:   []string{},
		},
		{
			name:          "badprovider",
			wantOK:        false,
			wantFindings:  []string{"error:provider-not-allowlisted"},
			wantProviders: []string{"evilcorp/backdoor"},
			wantModules:   []string{},
		},
		{
			name:          "badprovider-custom-allowlist",
			allowlist:     []string{"evilcorp/backdoor"},
			wantOK:        true,
			wantFindings:  []string{},
			wantProviders: []string{"evilcorp/backdoor"},
			wantModules:   []string{},
		},
		{
			name:          "backend",
			wantOK:        true,
			wantFindings:  []string{"warning:backend-declared"},
			wantProviders: []string{"hashicorp/aws"},
			wantModules:   []string{},
		},
		{
			name:          "cloudblock",
			wantOK:        true,
			wantFindings:  []string{"warning:backend-declared"},
			wantProviders: []string{},
			wantModules:   []string{},
		},
		{
			name:          "childviolation",
			wantOK:        false,
			wantFindings:  []string{"error:provisioner-block"},
			wantProviders: []string{"hashicorp/aws"},
			wantModules:   []string{"./modules/child"},
		},
		{
			name:   "escape",
			wantOK: false,
			wantFindings: []string{
				"error:module-escapes-root",
				"error:module-escapes-root",
			},
			wantProviders: []string{},
			wantModules:   []string{"../", "../../../outside"},
		},
		{
			name:          "sources",
			wantOK:        true,
			wantFindings:  []string{},
			wantProviders: []string{},
			wantModules: []string{
				"git::https://github.com/example/mod.git?ref=v1.0.0",
				"terraform-aws-modules/vpc/aws",
			},
		},
		{
			name:   "json",
			wantOK: false,
			wantFindings: []string{
				"error:external-data-source",
				"error:module-source-unresolvable",
				"error:provider-not-allowlisted",
				"error:provisioner-block",
				"warning:backend-declared",
				"warning:provider-implied",
			},
			wantProviders: []string{"evilcorp/backdoor"},
			wantModules:   []string{"terraform-aws-modules/vpc/aws"},
		},
		{
			name:          "implied",
			wantOK:        true,
			wantFindings:  []string{"warning:provider-implied"},
			wantProviders: []string{},
			wantModules:   []string{},
		},
		{
			name:          "legacy",
			wantOK:        true,
			wantFindings:  []string{},
			wantProviders: []string{"hashicorp/aws"},
			wantModules:   []string{},
		},
		{
			name:          "hoststrip",
			wantOK:        true,
			wantFindings:  []string{},
			wantProviders: []string{"hashicorp/aws", "hashicorp/google"},
			wantModules:   []string{},
		},
		{
			name:          "cycle",
			wantOK:        true,
			wantFindings:  []string{},
			wantProviders: []string{},
			wantModules:   []string{"../a", "../b", "./mods/a"},
		},
		{
			name:   "httpdata",
			wantOK: true,
			wantFindings: []string{
				"warning:http-data-source",
				"warning:provider-implied",
			},
			wantProviders: []string{},
			wantModules:   []string{},
		},
		{
			name:   "unresolvable",
			wantOK: false,
			wantFindings: []string{
				"error:module-source-unresolvable",
				"error:module-source-unresolvable",
				"error:provider-not-allowlisted",
				"error:provider-not-allowlisted",
				"error:provider-not-allowlisted",
				"error:provider-not-allowlisted",
			},
			wantProviders: []string{},
			wantModules:   []string{},
		},
		{
			name:   "missingmodule",
			wantOK: true,
			wantFindings: []string{
				"warning:module-not-found",
				"warning:module-not-found",
			},
			wantProviders: []string{},
			wantModules:   []string{"./nope", "./notdir.txt"},
		},
		{
			name:   "json2",
			wantOK: false,
			wantFindings: []string{
				"error:module-source-unresolvable",
				"warning:backend-declared",
				"warning:http-data-source",
				"warning:provider-implied",
			},
			wantProviders: []string{},
			wantModules:   []string{"./child"},
		},
		{
			name:   "weird",
			wantOK: false,
			wantFindings: []string{
				"error:module-source-unresolvable",
				"error:provisioner-block",
			},
			wantProviders: []string{},
			wantModules:   []string{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := filepath.Join("testdata", tc.name)
			if tc.name == "badprovider-custom-allowlist" {
				dir = filepath.Join("testdata", "badprovider")
			}
			report, err := Scan(dir, tc.allowlist)
			if err != nil {
				t.Fatalf("Scan(%q) error: %v", dir, err)
			}
			if report.OK != tc.wantOK {
				t.Errorf("OK = %v, want %v (findings: %+v)", report.OK, tc.wantOK, report.Findings)
			}
			if got := findingKeys(report); !reflect.DeepEqual(got, tc.wantFindings) {
				t.Errorf("findings = %v, want %v (full: %+v)", got, tc.wantFindings, report.Findings)
			}
			if !reflect.DeepEqual(report.Providers, tc.wantProviders) {
				t.Errorf("providers = %v, want %v", report.Providers, tc.wantProviders)
			}
			if !reflect.DeepEqual(report.Modules, tc.wantModules) {
				t.Errorf("modules = %v, want %v", report.Modules, tc.wantModules)
			}
		})
	}
}

// TestScanParseError asserts unparseable .tf and .tf.json input fails closed
// with parse-error findings.
func TestScanParseError(t *testing.T) {
	for _, fixture := range []string{"parseerror", "jsonparseerror"} {
		t.Run(fixture, func(t *testing.T) {
			report, err := Scan(filepath.Join("testdata", fixture), nil)
			if err != nil {
				t.Fatalf("Scan error: %v", err)
			}
			if report.OK {
				t.Fatal("OK = true for unparseable input, want false (fail closed)")
			}
			if len(report.Findings) == 0 {
				t.Fatal("no findings for unparseable input")
			}
			for _, f := range report.Findings {
				if f.Rule != RuleParseError || f.Severity != SeverityError {
					t.Errorf("unexpected finding %+v, want error:parse-error", f)
				}
			}
		})
	}
}

// TestChildViolationLocation asserts findings inside a local child module
// carry the repo-relative file path and a real line number.
func TestChildViolationLocation(t *testing.T) {
	report, err := Scan(filepath.Join("testdata", "childviolation"), nil)
	if err != nil {
		t.Fatalf("Scan error: %v", err)
	}
	if len(report.Findings) != 1 {
		t.Fatalf("findings = %+v, want exactly one", report.Findings)
	}
	f := report.Findings[0]
	if f.File != "modules/child/main.tf" {
		t.Errorf("File = %q, want modules/child/main.tf", f.File)
	}
	if f.Line != 2 {
		t.Errorf("Line = %d, want 2", f.Line)
	}
}

// TestJSONFindingLines asserts .tf.json findings carry real line numbers,
// including the raw-sweep provisioner finding.
func TestJSONFindingLines(t *testing.T) {
	report, err := Scan(filepath.Join("testdata", "json"), nil)
	if err != nil {
		t.Fatalf("Scan error: %v", err)
	}
	for _, f := range report.Findings {
		if f.Line <= 0 {
			t.Errorf("finding %+v has no line number", f)
		}
		if f.File != "main.tf.json" {
			t.Errorf("finding %+v: File = %q, want main.tf.json", f, f.File)
		}
	}
}

// TestScanEmptyDir asserts an empty module scans clean.
func TestScanEmptyDir(t *testing.T) {
	report, err := Scan(t.TempDir(), nil)
	if err != nil {
		t.Fatalf("Scan error: %v", err)
	}
	if !report.OK || len(report.Findings) != 0 {
		t.Errorf("empty dir: OK=%v findings=%+v, want clean pass", report.OK, report.Findings)
	}
}

// TestScanRootErrors asserts Scan rejects missing roots and non-directories.
func TestScanRootErrors(t *testing.T) {
	if _, err := Scan(filepath.Join(t.TempDir(), "missing"), nil); err == nil {
		t.Error("Scan(missing dir) = nil error, want error")
	}
	file := filepath.Join(t.TempDir(), "f.tf")
	if err := os.WriteFile(file, []byte("x = 1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Scan(file, nil); err == nil {
		t.Error("Scan(regular file) = nil error, want error")
	}
}

// TestSymlinkEscape asserts a local module source that stays inside the root
// lexically but escapes it via a symlink is rejected.
func TestSymlinkEscape(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "root")
	outside := filepath.Join(base, "outside")
	for _, d := range []string{root, outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(outside, "main.tf"),
		[]byte("resource \"null_resource\" \"x\" {\n  provisioner \"local-exec\" {\n    command = \"id\"\n  }\n}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "main.tf"),
		[]byte("module \"m\" {\n  source = \"./link\"\n}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Skipf("cannot create symlink: %v", err)
	}
	report, err := Scan(root, nil)
	if err != nil {
		t.Fatalf("Scan error: %v", err)
	}
	if report.OK {
		t.Fatalf("OK = true, want false: symlinked module escaped the root undetected (findings: %+v)", report.Findings)
	}
	found := false
	for _, f := range report.Findings {
		if f.Rule == RuleModuleEscapesRoot {
			found = true
		}
		if f.Rule == RuleProvisionerBlock {
			t.Errorf("scanner followed the escaping symlink and scanned outside content: %+v", f)
		}
	}
	if !found {
		t.Errorf("no module-escapes-root finding; findings: %+v", report.Findings)
	}
}

// TestDefaultProviderAllowlist spot-checks the built-in set.
func TestDefaultProviderAllowlist(t *testing.T) {
	got := DefaultProviderAllowlist()
	want := map[string]bool{
		"hashicorp/aws": true, "hashicorp/google": true, "hashicorp/google-beta": true,
		"hashicorp/azurerm": true, "hashicorp/azuread": true, "hashicorp/alicloud": true,
		"hashicorp/kubernetes": true, "hashicorp/helm": true, "hashicorp/tls": true,
		"hashicorp/random": true, "hashicorp/time": true, "hashicorp/cloudinit": true,
		"hashicorp/dns": true, "hashicorp/local": true, "hashicorp/null": true,
		"hashicorp/template": true, "aliyun/alicloud": true, "hetznercloud/hcloud": true,
	}
	if len(got) != len(want) {
		t.Errorf("allowlist has %d entries, want %d", len(got), len(want))
	}
	for _, a := range got {
		if !want[a] {
			t.Errorf("unexpected allowlist entry %q", a)
		}
	}
}

// TestNormalizeProviderSource covers host-stripping, lowercasing, and
// implied-namespace expansion.
func TestNormalizeProviderSource(t *testing.T) {
	cases := map[string]string{
		"hashicorp/aws":                        "hashicorp/aws",
		"HashiCorp/AWS":                        "hashicorp/aws",
		"registry.terraform.io/hashicorp/aws":  "hashicorp/aws",
		"registry.opentofu.org/hashicorp/aws":  "hashicorp/aws",
		"aws":                                  "hashicorp/aws",
		"  hetznercloud/hcloud  ":              "hetznercloud/hcloud",
		"example.com/evilcorp/backdoor":        "example.com/evilcorp/backdoor",
		"registry.opentofu.org/evilcorp/tools": "evilcorp/tools",
		"":                                     "",
	}
	for in, want := range cases {
		if got := normalizeProviderSource(in); got != want {
			t.Errorf("normalizeProviderSource(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestAllowlistFromEnv covers unset, populated, and degenerate env values.
func TestAllowlistFromEnv(t *testing.T) {
	t.Setenv(AllowlistEnvVar, "")
	if got := AllowlistFromEnv(); !reflect.DeepEqual(got, DefaultProviderAllowlist()) {
		t.Errorf("unset env: got %v, want default set", got)
	}

	t.Setenv(AllowlistEnvVar, " evilcorp/backdoor , hashicorp/aws ,")
	if got := AllowlistFromEnv(); !reflect.DeepEqual(got, []string{"evilcorp/backdoor", "hashicorp/aws"}) {
		t.Errorf("populated env: got %v", got)
	}

	t.Setenv(AllowlistEnvVar, " ,  , ")
	if got := AllowlistFromEnv(); !reflect.DeepEqual(got, DefaultProviderAllowlist()) {
		t.Errorf("blank entries: got %v, want default set", got)
	}
}

// TestEnvOverrideEndToEnd asserts the env-provided allowlist flows through
// Scan: a provider the default set rejects passes when the env allows it.
func TestEnvOverrideEndToEnd(t *testing.T) {
	dir := filepath.Join("testdata", "badprovider")

	t.Setenv(AllowlistEnvVar, "evilcorp/backdoor")
	report, err := Scan(dir, AllowlistFromEnv())
	if err != nil {
		t.Fatalf("Scan error: %v", err)
	}
	if !report.OK {
		t.Errorf("env-allowlisted provider still rejected: %+v", report.Findings)
	}

	t.Setenv(AllowlistEnvVar, "")
	report, err = Scan(dir, AllowlistFromEnv())
	if err != nil {
		t.Fatalf("Scan error: %v", err)
	}
	if report.OK {
		t.Error("default allowlist accepted evilcorp/backdoor")
	}
}

// TestJSONKeyLines unit-tests the raw JSON key sweep.
func TestJSONKeyLines(t *testing.T) {
	src := []byte(`{
  "a": {
    "provisioner": {"x": 1},
    "b": ["provisioner", {"provisioner": true}],
    "c": "provisioner"
  }
}`)
	lines, err := jsonKeyLines(src, "provisioner")
	if err != nil {
		t.Fatalf("jsonKeyLines error: %v", err)
	}
	// Key on line 3 and the object-in-array key on line 4; the two string
	// VALUES "provisioner" (lines 4 and 5) must not match.
	if !reflect.DeepEqual(lines, []int{3, 4}) {
		t.Errorf("lines = %v, want [3 4]", lines)
	}

	if _, err := jsonKeyLines([]byte(`{"a": `), "provisioner"); err == nil {
		t.Error("truncated JSON: err = nil, want error")
	}

	lines, err = jsonKeyLines([]byte(`[1, "provisioner", null]`), "provisioner")
	if err != nil || len(lines) != 0 {
		t.Errorf("array-only doc: lines=%v err=%v, want none", lines, err)
	}

	if got := lineAtOffset([]byte("a\nb"), 99); got != 2 {
		t.Errorf("lineAtOffset out-of-range clamp = %d, want 2", got)
	}
}
