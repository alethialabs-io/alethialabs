// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package iacsafety

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
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
			// Registry and git module sources: never fetched, so never vetted —
			// rejected outright.
			name:   "sources",
			wantOK: false,
			wantFindings: []string{
				"error:remote-module-source",
				"error:remote-module-source",
			},
			wantProviders: []string{},
			wantModules: []string{
				"git::https://github.com/example/mod.git?ref=v1.0.0",
				"terraform-aws-modules/vpc/aws",
			},
		},
		{
			// Absolute, ~, and bare ".." module sources: OpenTofu installs and
			// runs all of them, so they count as non-local and are rejected.
			name:   "absmodule",
			wantOK: false,
			wantFindings: []string{
				"error:remote-module-source",
				"error:remote-module-source",
				"error:remote-module-source",
			},
			wantProviders: []string{},
			wantModules:   []string{"..", "/opt/evil-module", "~/evil-module"},
		},
		{
			name:   "json",
			wantOK: false,
			wantFindings: []string{
				"error:external-data-source",
				"error:module-source-unresolvable",
				"error:provider-implied",
				"error:provider-not-allowlisted",
				"error:provisioner-block",
				"error:remote-module-source",
				"warning:backend-declared",
			},
			wantProviders: []string{"evilcorp/backdoor"},
			wantModules:   []string{"terraform-aws-modules/vpc/aws"},
		},
		{
			name:          "implied",
			wantOK:        false,
			wantFindings:  []string{"error:provider-implied"},
			wantProviders: []string{},
			wantModules:   []string{},
		},
		{
			// An implied provider that is NOT allowlisted (vault_generic_secret →
			// hashicorp/vault) is an error: init would download the binary.
			name:          "impliedvault",
			wantOK:        false,
			wantFindings:  []string{"error:provider-implied"},
			wantProviders: []string{},
			wantModules:   []string{},
		},
		{
			// ephemeral (tofu 1.10+) instantiates a provider at plan like data/
			// resource — a non-allowlisted implied provider must still be gated.
			name:          "ephemeralvault",
			wantOK:        false,
			wantFindings:  []string{"error:provider-implied"},
			wantProviders: []string{},
			wantModules:   []string{},
		},
		{
			// ephemeral in .tf.json is gated identically.
			name:          "ephemeraljson",
			wantOK:        false,
			wantFindings:  []string{"error:provider-implied"},
			wantProviders: []string{},
			wantModules:   []string{},
		},
		{
			// import (tofu 1.5+) pulls the provider of its `to` address at init —
			// gate the implied provider from the `to` resource type.
			name:          "importvault",
			wantOK:        false,
			wantFindings:  []string{"error:provider-implied"},
			wantProviders: []string{},
			wantModules:   []string{},
		},
		{
			// import in .tf.json is gated identically.
			name:          "importjson",
			wantOK:        false,
			wantFindings:  []string{"error:provider-implied"},
			wantProviders: []string{},
			wantModules:   []string{},
		},
		{
			// A module-nested `to` address (module.storage.aws_s3_bucket.assets)
			// resolves to the aws resource type, which IS allowlisted → passes,
			// proving the module-address parsing finds the real type.
			name:          "importmodule",
			wantOK:        true,
			wantFindings:  []string{},
			wantProviders: []string{},
			wantModules:   []string{},
		},
		{
			// An ephemeral resource whose provider IS allowlisted (random) passes,
			// proving the gate doesn't false-positive on legitimate ephemerals.
			name:          "ephemeralclean",
			wantOK:        true,
			wantFindings:  []string{},
			wantProviders: []string{"hashicorp/random"},
			wantModules:   []string{},
		},
		{
			// .tofu files are first-class OpenTofu config and must be scanned
			// exactly like .tf — evil provider, provisioner, and data "external"
			// all caught.
			name:   "tofu",
			wantOK: false,
			wantFindings: []string{
				"error:external-data-source",
				"error:provider-implied",
				"error:provider-not-allowlisted",
				"error:provisioner-block",
			},
			wantProviders: []string{"evilcorp/backdoor"},
			wantModules:   []string{},
		},
		{
			// .tofu.json files likewise.
			name:   "tofujson",
			wantOK: false,
			wantFindings: []string{
				"error:external-data-source",
				"error:provider-implied",
				"error:provider-not-allowlisted",
				"error:provisioner-block",
			},
			wantProviders: []string{"evilcorp/backdoor"},
			wantModules:   []string{},
		},
		{
			// data "external" scoped inside a check block executes during plan
			// exactly like a top-level one and must be caught (native HCL).
			name:   "checkdata",
			wantOK: false,
			wantFindings: []string{
				"error:external-data-source",
				"error:provider-implied",
			},
			wantProviders: []string{},
			wantModules:   []string{},
		},
		{
			// Same check-block bypass in JSON syntax.
			name:   "checkdatajson",
			wantOK: false,
			wantFindings: []string{
				"error:external-data-source",
				"error:provider-implied",
			},
			wantProviders: []string{},
			wantModules:   []string{},
		},
		{
			// data "http" in a check block draws the http warning; with
			// hashicorp/http allowlisted there is nothing else to flag.
			name:          "checkhttp",
			allowlist:     []string{"hashicorp/http"},
			wantOK:        true,
			wantFindings:  []string{"warning:http-data-source"},
			wantProviders: []string{},
			wantModules:   []string{},
		},
		{
			// data "terraform_remote_state" reads arbitrary remote state at
			// plan time: surfaced as a warning (sometimes legitimate).
			name:          "remotestate",
			wantOK:        true,
			wantFindings:  []string{"warning:remote-state-data-source"},
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
			wantOK: false,
			wantFindings: []string{
				"error:provider-implied",
				"warning:http-data-source",
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
			// A customer-committed `*_override.tf` file is rejected by NAME: it
			// merges last and can shadow the platform backend override.
			name:          "overridefile",
			wantOK:        false,
			wantFindings:  []string{"error:override-file"},
			wantProviders: []string{"hashicorp/aws"},
			wantModules:   []string{},
		},
		{
			name:   "json2",
			wantOK: false,
			wantFindings: []string{
				"error:module-source-unresolvable",
				"error:provider-implied",
				"warning:backend-declared",
				"warning:http-data-source",
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

// TestIsOverrideFile pins the OpenTofu override-file name detection across the
// `override.*` / `*_override.*` forms and every config extension.
func TestIsOverrideFile(t *testing.T) {
	overrides := []string{
		"override.tf", "override.tofu", "override.tf.json", "override.tofu.json",
		"x_override.tf", "backend_override.tofu", "a_b_override.tf.json", "z_override.tofu.json",
	}
	for _, n := range overrides {
		if !isOverrideFile(n) {
			t.Errorf("isOverrideFile(%q) = false, want true", n)
		}
	}
	nonOverrides := []string{
		"main.tf", "overrides.tf", "override.txt", "myoverride.tf", // "myoverride" stem, not "_override"
		"override", "overridefile.tofu", "readme.md",
	}
	for _, n := range nonOverrides {
		if isOverrideFile(n) {
			t.Errorf("isOverrideFile(%q) = true, want false", n)
		}
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

// TestJSONDangerousKeys unit-tests the raw JSON dangerous-key sweep.
func TestJSONDangerousKeys(t *testing.T) {
	src := []byte(`{
  "a": {
    "provisioner": {"x": 1},
    "b": ["provisioner", {"provisioner": true}],
    "c": "provisioner"
  },
  "data": [{"external": {"p": {}}}],
  "nested": {"data": {"http": {"q": {}}, "terraform_remote_state": {"r": {}}, "safe": {}}},
  "external": {"not-under-data": true},
  "alsodata": {"external": "scalar values still match keys, not values"}
}`)
	hits, err := jsonDangerousKeys(src)
	if err != nil {
		t.Fatalf("jsonDangerousKeys error: %v", err)
	}
	// provisioner keys on lines 3 and 4 (the two string VALUES "provisioner"
	// on lines 4 and 5 must not match); "external" under the repeated-block
	// data array (line 7); "http" and "terraform_remote_state" under a nested
	// "data" key (line 8, "safe" must not match); a root-level "external"
	// (line 9) and an "external" under a non-"data" key (line 10) must not
	// match.
	want := []jsonKeyHit{
		{key: "provisioner", line: 3},
		{key: "provisioner", line: 4},
		{key: "external", line: 7},
		{key: "http", line: 8},
		{key: "terraform_remote_state", line: 8},
	}
	if !reflect.DeepEqual(hits, want) {
		t.Errorf("hits = %+v, want %+v", hits, want)
	}

	if _, err := jsonDangerousKeys([]byte(`{"a": `)); err == nil {
		t.Error("truncated JSON: err = nil, want error")
	}

	hits, err = jsonDangerousKeys([]byte(`[1, "provisioner", null]`))
	if err != nil || len(hits) != 0 {
		t.Errorf("array-only doc: hits=%v err=%v, want none", hits, err)
	}

	if got := lineAtOffset([]byte("a\nb"), 99); got != 2 {
		t.Errorf("lineAtOffset out-of-range clamp = %d, want 2", got)
	}
}

// TestConfigSuffixesCoverOpenTofu pins the exhaustive set of file suffixes
// OpenTofu loads as module configuration. If OpenTofu grows a new config
// extension, this test forces the dispatch list (and this policy) to be
// updated deliberately — silently skipping a config file is a total gate
// bypass (that is exactly how .tofu files slipped through before).
func TestConfigSuffixesCoverOpenTofu(t *testing.T) {
	want := map[string]bool{ // suffix -> parsed as JSON
		".tf":        false,
		".tf.json":   true,
		".tofu":      false,
		".tofu.json": true,
	}
	if len(configSuffixes) != len(want) {
		t.Fatalf("configSuffixes has %d entries, want %d: %+v", len(configSuffixes), len(want), configSuffixes)
	}
	for i, cs := range configSuffixes {
		isJSON, ok := want[cs.suffix]
		if !ok {
			t.Errorf("unexpected config suffix %q", cs.suffix)
			continue
		}
		if cs.json != isJSON {
			t.Errorf("suffix %q: json = %v, want %v", cs.suffix, cs.json, isJSON)
		}
		// Ordering invariant: no earlier entry may shadow a later, more
		// specific one (first match wins in scanModuleDir).
		for j := 0; j < i; j++ {
			if strings.HasSuffix(cs.suffix, configSuffixes[j].suffix) {
				t.Errorf("suffix %q is shadowed by earlier entry %q", cs.suffix, configSuffixes[j].suffix)
			}
		}
	}
}

// addressesOf reduces a report's declared inventory to its Terraform addresses.
func addressesOf(r *Report) []string {
	out := make([]string, 0, len(r.Resources))
	for _, res := range r.Resources {
		out = append(out, res.Address())
	}
	return out
}

// TestScanResourceInventory pins the DECLARED resource inventory — what the console draws
// as read-only `external` cards so a BYO-IaC environment reads as an architecture before it
// has ever been planned.
//
// The contract this locks down:
//   - `resource` blocks are inventoried; `data`, `provider`, `output` and `variable` are NOT
//     (they provision nothing). Output NAMES are captured separately in `Report.Outputs`
//     for the BYO-IaC binding picker — see TestScanOutputInventory — never in `Resources`.
//   - child modules are inventoried under their Terraform module path (`module.<call>.…`),
//     including a module CALLED from JSON config, so the address matches what a plan emits.
//   - the inventory is sorted by address (the report is persisted and diffed).
func TestScanResourceInventory(t *testing.T) {
	cases := []struct {
		name string
		want []string
	}{
		{
			// Two resource blocks; the `data "aws_ami"`, the provider, the variable and the
			// output must all be absent — only resources are architecture.
			name: "clean",
			want: []string{"aws_instance.web", "terraform_data.marker"},
		},
		{
			// The root declares no resources; the local child module's resource is inventoried
			// under the module path of the block that CALLS it.
			name: "childviolation",
			want: []string{"module.child.null_resource.hook"},
		},
		{
			// The module call lives in .tf.json — the JSON walker must thread the call name
			// through too, or the child's resources would land in the root module path.
			name: "json2",
			want: []string{"module.child.null_resource.marker"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rep, err := Scan(filepath.Join("testdata", tc.name), nil)
			if err != nil {
				t.Fatalf("Scan: %v", err)
			}
			if got := addressesOf(rep); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("resources = %v, want %v", got, tc.want)
			}
			// Sorted by address — a persisted, diffed report must be deterministic.
			if !sort.SliceIsSorted(rep.Resources, func(i, j int) bool {
				return rep.Resources[i].Address() < rep.Resources[j].Address()
			}) {
				t.Errorf("inventory is not sorted by address: %v", addressesOf(rep))
			}
		})
	}
}

// TestScanOutputInventory pins Report.Outputs — the ROOT module's declared `output` block
// names the console offers as binding targets when a service binds to a BYO-IaC resource
// (#687). The contract:
//   - root outputs are captured from BOTH `.tf` (native walk) and `.tf.json` (JSON walk);
//   - a CHILD module's output is EXCLUDED (`tofu output` returns only root outputs, so a
//     binding could never resolve against a child's name — surfacing it would be a lie);
//   - the list is sorted (the report is persisted and diffed).
func TestScanOutputInventory(t *testing.T) {
	rep, err := Scan(filepath.Join("testdata", "outputs"), nil)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	want := []string{"db_endpoint", "db_secret_name", "json_out"} // child "internal" excluded
	if !reflect.DeepEqual(rep.Outputs, want) {
		t.Errorf("outputs = %v, want %v", rep.Outputs, want)
	}
	if !sort.StringsAreSorted(rep.Outputs) {
		t.Errorf("outputs not sorted: %v", rep.Outputs)
	}
}

// TestResourceAddress pins the address format against Terraform's own — this string is the
// join key for cost (environment_cost.resources), drift (environment_drift.details) and
// verify findings. Get it wrong and every overlay silently misses.
func TestResourceAddress(t *testing.T) {
	cases := []struct {
		res  Resource
		want string
	}{
		{Resource{Type: "aws_s3_bucket", Name: "assets"}, "aws_s3_bucket.assets"},
		{Resource{Type: "aws_subnet", Name: "this", Module: "module.vpc"}, "module.vpc.aws_subnet.this"},
		{
			Resource{Type: "aws_eks_cluster", Name: "main", Module: "module.a.module.b"},
			"module.a.module.b.aws_eks_cluster.main",
		},
	}
	for _, tc := range cases {
		if got := tc.res.Address(); got != tc.want {
			t.Errorf("Address() = %q, want %q", got, tc.want)
		}
	}
}
