// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package iacsafety

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

// writeModuleTree materialises a name→content map (paths are slash-separated and
// relative) into a fresh temp dir and returns that dir. Unlike the checked-in
// testdata fixtures it keeps the malformed/degenerate inputs below out of the
// fixture set, where a stray `.tf` file would join every other fixture walk.
func writeModuleTree(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir for %s: %v", name, err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	return dir
}

// TestScanDegenerateConfigShapes pins the policy's behaviour on config shapes a
// well-formed module never has: structurally malformed JSON bodies, blocks with
// missing/непarsable attributes, empty block labels, and local module sources
// that do not resolve to a directory.
//
// The invariant under test is the package's fail-closed contract: anything the
// walk cannot decode becomes an ERROR finding (never a silent pass), while the
// shapes OpenTofu would itself reject at init — a missing module directory, a
// module source pointing at a file — stay WARNINGS because the plan can never
// reach them.
func TestScanDegenerateConfigShapes(t *testing.T) {
	cases := []struct {
		name         string
		files        map[string]string
		wantOK       bool
		wantFindings []string // sorted "severity:rule", see findingKeys
		wantResource []string
	}{
		{
			// A JSON "resource" that is not an object cannot be decoded against the
			// block schema — fail closed rather than skip the file.
			name:         "json resource is not an object",
			files:        map[string]string{"main.tf.json": `{"resource":"nope"}`},
			wantOK:       false,
			wantFindings: []string{"error:parse-error", "error:parse-error"},
		},
		{
			// Same rule one level down: a check{} block whose "data" is not an object.
			name:         "json check block data is not an object",
			files:        map[string]string{"main.tf.json": `{"check":{"c":{"data":"nope"}}}`},
			wantOK:       false,
			wantFindings: []string{"error:parse-error", "error:parse-error"},
		},
		{
			name:         "json terraform block is not an object",
			files:        map[string]string{"main.tf.json": `{"terraform":"nope"}`},
			wantOK:       false,
			wantFindings: []string{"error:parse-error"},
		},
		{
			name:         "json required_providers is not an object",
			files:        map[string]string{"main.tf.json": `{"terraform":{"required_providers":"nope"}}`},
			wantOK:       false,
			wantFindings: []string{"error:parse-error"},
		},
		{
			name:         "json module body is not an object",
			files:        map[string]string{"main.tf.json": `{"module":{"a":"nope"}}`},
			wantOK:       false,
			wantFindings: []string{"error:parse-error"},
		},
		{
			name:         "json module block has no source",
			files:        map[string]string{"main.tf.json": `{"module":{"a":{"version":"1.0"}}}`},
			wantOK:       false,
			wantFindings: []string{"error:module-source-unresolvable"},
		},
		{
			// An import block with no `to` implies no provider — nothing to gate.
			name:         "json import block without a to address",
			files:        map[string]string{"main.tf.json": `{"import":{"id":"x"}}`},
			wantOK:       true,
			wantFindings: []string{},
		},
		{
			// "single" has no TYPE.NAME shape, so no provider can be derived.
			name:         "json import to address is too short",
			files:        map[string]string{"main.tf.json": `{"import":{"to":"single","id":"y"}}`},
			wantOK:       true,
			wantFindings: []string{},
		},
		{
			// terraform_remote_state is surfaced but not blocking, and its implied
			// provider is the builtin "terraform" one, which is exempt.
			name:         "json terraform_remote_state warns without blocking",
			files:        map[string]string{"main.tf.json": `{"data":{"terraform_remote_state":{"x":{"backend":"local"}}}}`},
			wantOK:       true,
			wantFindings: []string{"warning:remote-state-data-source"},
		},
		{
			name:   "json backend and cloud are both warned",
			files:  map[string]string{"main.tf.json": `{"terraform":{"backend":{"s3":{}},"cloud":{}}}`},
			wantOK: true,
			wantFindings: []string{
				"warning:backend-declared",
				"warning:backend-declared",
			},
		},
		{
			name:         "native import block without a to address",
			files:        map[string]string{"main.tf": "import {\n  id = \"x\"\n}\n"},
			wantOK:       true,
			wantFindings: []string{},
		},
		{
			name:         "native import to address is too short",
			files:        map[string]string{"main.tf": "import {\n  to = single\n  id = \"x\"\n}\n"},
			wantOK:       true,
			wantFindings: []string{},
		},
		{
			// Empty labels name neither a provider nor a resource: the inventory and
			// the implied-provider queue must both stay empty rather than record "".
			name:         "resource block with empty labels is not inventoried",
			files:        map[string]string{"main.tf": "resource \"\" \"\" {}\n"},
			wantOK:       true,
			wantFindings: []string{},
			wantResource: []string{},
		},
		{
			// A module block with no call label contributes no module-path segment,
			// so the child's resources land under the caller's path (root here).
			name: "module block without a call label keeps the parent module path",
			files: map[string]string{
				"main.tf":     "module {\n  source = \"./sub\"\n}\n",
				"sub/main.tf": "resource \"aws_s3_bucket\" \"b\" {}\n",
			},
			wantOK:       true,
			wantFindings: []string{},
			wantResource: []string{"aws_s3_bucket.b"},
		},
		{
			name:         "required_providers entry with an unsupported value shape",
			files:        map[string]string{"main.tf": "terraform {\n  required_providers {\n    aws = 3\n  }\n}\n"},
			wantOK:       false,
			wantFindings: []string{"error:provider-not-allowlisted"},
		},
		{
			name:         "required_providers source is not a string",
			files:        map[string]string{"main.tf": "terraform {\n  required_providers {\n    aws = { source = 3 }\n  }\n}\n"},
			wantOK:       false,
			wantFindings: []string{"error:provider-not-allowlisted"},
		},
		{
			name:         "native module block has no source",
			files:        map[string]string{"main.tf": "module \"a\" {}\n"},
			wantOK:       false,
			wantFindings: []string{"error:module-source-unresolvable"},
		},
		{
			// Resolves, but to a file: OpenTofu would fail at init, so warn only.
			name: "local module source points at a file",
			files: map[string]string{
				"main.tf":   "module \"a\" {\n  source = \"./notes.txt\"\n}\n",
				"notes.txt": "hi\n",
			},
			wantOK:       true,
			wantFindings: []string{"warning:module-not-found"},
		},
		{
			name:         "local module source does not exist",
			files:        map[string]string{"main.tf": "module \"a\" {\n  source = \"./nope\"\n}\n"},
			wantOK:       true,
			wantFindings: []string{"warning:module-not-found"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			report, err := Scan(writeModuleTree(t, tc.files), nil)
			if err != nil {
				t.Fatalf("Scan error: %v", err)
			}
			if report.OK != tc.wantOK {
				t.Errorf("OK = %v, want %v (findings: %+v)", report.OK, tc.wantOK, report.Findings)
			}
			if got := findingKeys(report); !reflect.DeepEqual(got, tc.wantFindings) {
				t.Errorf("findings = %v, want %v", got, tc.wantFindings)
			}
			if tc.wantResource != nil {
				if got := addressesOf(report); !reflect.DeepEqual(got, tc.wantResource) {
					t.Errorf("resources = %v, want %v", got, tc.wantResource)
				}
			}
		})
	}
}

// TestScanUnreadableModuleDirFailsClosed asserts that a module directory the
// scanner cannot list aborts the whole scan with an error rather than yielding a
// partial report. Callers (provisioner.scanByoIacFailClosed,
// agent.stage) treat a Scan error as a block, so an unlistable directory must
// never come back as an OK report with the directory silently skipped.
func TestScanUnreadableModuleDirFailsClosed(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("directory permissions do not gate reads for this user/OS")
	}
	dir := writeModuleTree(t, map[string]string{
		"main.tf":     "module \"a\" {\n  source = \"./sub\"\n}\n",
		"sub/main.tf": "resource \"aws_s3_bucket\" \"b\" {}\n",
	})
	sub := filepath.Join(dir, "sub")
	if err := os.Chmod(sub, 0o000); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	// Restore before TempDir cleanup, which otherwise cannot remove the tree.
	t.Cleanup(func() { _ = os.Chmod(sub, 0o755) })

	report, err := Scan(dir, nil)
	if err == nil {
		t.Fatalf("Scan returned no error for an unreadable module dir; report = %+v", report)
	}
	if report != nil {
		t.Errorf("report = %+v, want nil alongside the error", report)
	}
}

// TestJSONDangerousKeysDecodeError covers the sweep's non-EOF decoder failure:
// a byte sequence encoding/json rejects mid-stream must surface the decoder's
// error (so scanJSONFile records a parse-error finding) rather than returning
// the hits collected so far as if the sweep had completed.
func TestJSONDangerousKeysDecodeError(t *testing.T) {
	hits, err := jsonDangerousKeys([]byte(`{"provisioner": 1, "a": @}`))
	if err == nil {
		t.Fatalf("err = nil, want a decode error (hits = %+v)", hits)
	}
	if errors.Is(err, io.ErrUnexpectedEOF) {
		t.Errorf("err = %v, want a syntax error rather than the truncation error", err)
	}
	var syntaxErr *json.SyntaxError
	if !errors.As(err, &syntaxErr) {
		t.Errorf("err = %v (%T), want *json.SyntaxError", err, err)
	}
	// The keys found before the failure are still returned, but the error is what
	// the caller keys off — a partial sweep must never read as a clean one.
	if len(hits) != 1 || hits[0].key != "provisioner" {
		t.Errorf("hits = %+v, want the single pre-failure provisioner hit", hits)
	}
}

// TestJSONDangerousKeysTruncated covers the other decoder exit: json.Decoder
// reports a plain io.EOF between tokens even with containers still open, so the
// sweep must translate a non-empty frame stack into io.ErrUnexpectedEOF instead
// of reporting a clean end-of-document.
func TestJSONDangerousKeysTruncated(t *testing.T) {
	cases := []struct {
		name string
		src  string
	}{
		{name: "object left open", src: `{"data": {"external": {`},
		{name: "array left open", src: `{"data": [`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := jsonDangerousKeys([]byte(tc.src)); !errors.Is(err, io.ErrUnexpectedEOF) {
				t.Errorf("err = %v, want io.ErrUnexpectedEOF", err)
			}
		})
	}
}

// TestSplitDots pins the dotted-address splitter the JSON import path feeds into
// resourceTypeFromSegments — the pairing that decides which provider an import
// block implies.
func TestSplitDots(t *testing.T) {
	cases := []struct {
		in       string
		want     []string
		wantType string // resourceTypeFromSegments over the split
	}{
		{in: "", want: []string{""}, wantType: ""},
		{in: "single", want: []string{"single"}, wantType: ""},
		{in: "aws_s3_bucket.b", want: []string{"aws_s3_bucket", "b"}, wantType: "aws_s3_bucket"},
		{
			in:       "module.a.module.b.vault_kv_secret_v2.x",
			want:     []string{"module", "a", "module", "b", "vault_kv_secret_v2", "x"},
			wantType: "vault_kv_secret_v2",
		},
		{in: "trailing.", want: []string{"trailing", ""}, wantType: "trailing"},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got := splitDots(tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("splitDots(%q) = %v, want %v", tc.in, got, tc.want)
			}
			if gotType := resourceTypeFromSegments(got); gotType != tc.wantType {
				t.Errorf("resourceTypeFromSegments(%v) = %q, want %q", got, gotType, tc.wantType)
			}
		})
	}
}

// TestJoinModulePath pins how a child module's Terraform module path is built,
// including the unlabelled-call case where the child inherits the caller's path.
func TestJoinModulePath(t *testing.T) {
	cases := []struct {
		parent   string
		callName string
		want     string
	}{
		{parent: "", callName: "vpc", want: "module.vpc"},
		{parent: "module.a", callName: "b", want: "module.a.module.b"},
		{parent: "", callName: "", want: ""},
		{parent: "module.a", callName: "", want: "module.a"},
	}
	for _, tc := range cases {
		t.Run(tc.parent+"/"+tc.callName, func(t *testing.T) {
			if got := joinModulePath(tc.parent, tc.callName); got != tc.want {
				t.Errorf("joinModulePath(%q, %q) = %q, want %q", tc.parent, tc.callName, got, tc.want)
			}
		})
	}
}

// TestJSONDangerousKeysDataSourceTypes covers every data-source type the raw JSON
// sweep flags, in both the object and the repeated-block (array) encoding hcl's
// JSON syntax allows, and confirms the same key outside a "data" container is
// not flagged.
func TestJSONDangerousKeysDataSourceTypes(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want []jsonKeyHit
	}{
		{
			name: "external under data",
			src:  `{"data":{"external":{"x":{}}}}`,
			want: []jsonKeyHit{{key: "external", line: 1}},
		},
		{
			name: "http under data",
			src:  `{"data":{"http":{"x":{}}}}`,
			want: []jsonKeyHit{{key: "http", line: 1}},
		},
		{
			name: "terraform_remote_state under data",
			src:  `{"data":{"terraform_remote_state":{"x":{}}}}`,
			want: []jsonKeyHit{{key: "terraform_remote_state", line: 1}},
		},
		{
			name: "repeated-block array under data",
			src:  `{"data":[{"http":{"x":{}}},{"external":{"y":{}}}]}`,
			want: []jsonKeyHit{{key: "http", line: 1}, {key: "external", line: 1}},
		},
		{
			name: "same keys outside a data container are ignored",
			src:  `{"locals":{"external":1,"http":2,"terraform_remote_state":3}}`,
			want: nil,
		},
		{
			name: "unlisted data type is ignored",
			src:  `{"data":{"aws_ami":{"x":{}}}}`,
			want: nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hits, err := jsonDangerousKeys([]byte(tc.src))
			if err != nil {
				t.Fatalf("jsonDangerousKeys error: %v", err)
			}
			if !reflect.DeepEqual(hits, tc.want) {
				t.Errorf("hits = %+v, want %+v", hits, tc.want)
			}
		})
	}
}

// TestScanJSONRemoteStateEmitsWarningFinding wires the raw sweep's
// terraform_remote_state hit through to a real report, pinning the severity and
// rule the console renders. It is the JSON twin of the native-HCL case already
// covered by the `remotestate` fixture.
func TestScanJSONRemoteStateEmitsWarningFinding(t *testing.T) {
	dir := writeModuleTree(t, map[string]string{
		"main.tf.json": `{
  "data": {
    "terraform_remote_state": {
      "peer": {"backend": "local", "config": {"path": "../other/terraform.tfstate"}}
    }
  }
}`,
	})
	report, err := Scan(dir, nil)
	if err != nil {
		t.Fatalf("Scan error: %v", err)
	}
	if !report.OK {
		t.Errorf("OK = false, want true — remote state is surfaced, not blocked: %+v", report.Findings)
	}
	if len(report.Findings) != 1 {
		t.Fatalf("findings = %+v, want exactly one", report.Findings)
	}
	f := report.Findings[0]
	if f.Rule != RuleRemoteStateDataSource || f.Severity != SeverityWarning {
		t.Errorf("finding = %+v, want %s/%s", f, SeverityWarning, RuleRemoteStateDataSource)
	}
	if f.File != "main.tf.json" || f.Line != 3 {
		t.Errorf("location = %s:%d, want main.tf.json:3", f.File, f.Line)
	}
}
