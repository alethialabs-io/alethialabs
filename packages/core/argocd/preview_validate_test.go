// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// Both preview renderers write raw YAML through text/template, so every user-controlled field is a
// place a value can restructure the document rather than fill a slot. Before this, validate() on
// both inputs was presence-only for everything except PlacementMode.
//
// These tables assert BOTH directions. A guard that only ever rejects is as useless as one that
// only ever accepts: the rejection table proves each rule fires, and the acceptance table proves
// none of them refuses a value the product must support.

// previewRejects are inputs the app-half renderer must refuse.
var previewRejects = map[string]func(*PreviewAppSetInput){
	// --- apps path. The whole reason this file exists: ValidateAppsPath guards this same value
	// at five other sites and this renderer was the one that skipped it.
	"apps path escapes the repo root":     func(in *PreviewAppSetInput) { in.AppsPath = "../../etc" },
	"apps path is bare traversal":         func(in *PreviewAppSetInput) { in.AppsPath = ".." },
	"apps path traverses mid-string":      func(in *PreviewAppSetInput) { in.AppsPath = "a/../../b" },
	"apps path is absolute":               func(in *PreviewAppSetInput) { in.AppsPath = "/etc/passwd" },
	"apps path has a trailing slash":      func(in *PreviewAppSetInput) { in.AppsPath = "overlays/" },
	"apps path segment starts with a dot": func(in *PreviewAppSetInput) { in.AppsPath = ".git/config" },

	// --- namespace prefix. `-` rendered `namespace: -`, which is not even a well-formed YAML
	// scalar in the arm that emitted it unquoted.
	"namespace prefix is a lone dash":   func(in *PreviewAppSetInput) { in.NamespacePrefix = "-" },
	"namespace prefix is only dashes":   func(in *PreviewAppSetInput) { in.NamespacePrefix = "---" },
	"namespace prefix ends with a dash": func(in *PreviewAppSetInput) { in.NamespacePrefix = "preview-" },
	"namespace prefix starts w/ a dash": func(in *PreviewAppSetInput) { in.NamespacePrefix = "-preview" },
	"namespace prefix is uppercase":     func(in *PreviewAppSetInput) { in.NamespacePrefix = "Preview" },
	"namespace prefix has a slash":      func(in *PreviewAppSetInput) { in.NamespacePrefix = "a/b" },
	"namespace prefix leaves no room": func(in *PreviewAppSetInput) {
		in.NamespacePrefix = strings.Repeat("a", previewPrefixMaxLen+1)
	},

	// --- git provider. Rendered in YAML KEY position, so an enum rather than a charset.
	"git provider is unknown": func(in *PreviewAppSetInput) { in.GitProvider = "gitea" },
	"git provider adds a sibling key": func(in *PreviewAppSetInput) {
		in.GitProvider = "github:\n          owner: attacker"
	},

	// --- the remaining unquoted or unescaped interpolations.
	"repo owner has a line break":  func(in *PreviewAppSetInput) { in.RepoOwner = "acme\n          owner: evil" },
	"repo name has a colon":        func(in *PreviewAppSetInput) { in.RepoName = "shop: evil" },
	"token secret ref has a slash": func(in *PreviewAppSetInput) { in.TokenSecretRef = "ns/secret" },
	"token secret ref has a break": func(in *PreviewAppSetInput) { in.TokenSecretRef = "tok\n            key: x" },
	"dest server is not a URL":     func(in *PreviewAppSetInput) { in.DestServer = "not a url" },
	"dest server has a break":      func(in *PreviewAppSetInput) { in.DestServer = "https://a\n        x: y" },
	"dest server scheme is file":   func(in *PreviewAppSetInput) { in.DestServer = "file:///etc/passwd" },
	"apps repo URL has a break":    func(in *PreviewAppSetInput) { in.AppsRepoURL = "https://a\n        x: y" },
	"vcluster name is not a label": func(in *PreviewAppSetInput) {
		in.PlacementMode = types.PlacementModeVcluster
		in.VClusterName = "Bad_Name"
	},
	"project is not a label":        func(in *PreviewAppSetInput) { in.Project = "Demo_Project" },
	"project leaves no name budget": func(in *PreviewAppSetInput) { in.Project = strings.Repeat("a", 60) },

	// --- labels: key is a YAML key, value sits in unescaped double quotes.
	"label key has a line break":   func(in *PreviewAppSetInput) { in.Labels = map[string]string{"a\n    b": "v"} },
	"label key is not a label key": func(in *PreviewAppSetInput) { in.Labels = map[string]string{"-bad": "v"} },
	"label value has a quote":      func(in *PreviewAppSetInput) { in.Labels = map[string]string{"a": `v" evil: "x`} },
	"label value has a line break": func(in *PreviewAppSetInput) { in.Labels = map[string]string{"a": "v\n    b: c"} },
	"label value is too long":      func(in *PreviewAppSetInput) { in.Labels = map[string]string{"a": strings.Repeat("v", 64)} },
	"label key prefix is not a subdomain": func(in *PreviewAppSetInput) {
		in.Labels = map[string]string{"NOT_A_DOMAIN/x": "v"}
	},

	// Length bounds. Each of these is a branch the coverage profile showed unreached, not a
	// guess at what might be missing.
	"repo owner is over 100 characters": func(in *PreviewAppSetInput) { in.RepoOwner = strings.Repeat("a", 101) },
	"token secret ref is over 253 characters": func(in *PreviewAppSetInput) {
		in.TokenSecretRef = strings.Repeat("a", 254)
	},
	"vcluster name leaves no room": func(in *PreviewAppSetInput) {
		in.PlacementMode = types.PlacementModeVcluster
		in.VClusterName = strings.Repeat("a", previewPrefixMaxLen+1)
	},
	// `https:` parses with a scheme and an empty host, so the scheme check alone lets it through.
	"dest server has no host": func(in *PreviewAppSetInput) { in.DestServer = "https:" },
	// A destination is a Kubernetes API server, so the git transports are NOT valid there even
	// though they are valid for a repository URL.
	"dest server uses a git transport": func(in *PreviewAppSetInput) { in.DestServer = "ssh://cluster.internal" },
}

// previewAccepts are inputs the app-half renderer must still allow. Without these the rejection
// table above could be satisfied by a validator that refuses everything.
var previewAccepts = map[string]func(*PreviewAppSetInput){
	"empty apps path means the repo root": func(in *PreviewAppSetInput) { in.AppsPath = "" },
	"a dot apps path":                     func(in *PreviewAppSetInput) { in.AppsPath = "." },
	"a nested overlay path":               func(in *PreviewAppSetInput) { in.AppsPath = "examples/online-boutique/overlays/dev-1" },
	"a path with dots inside a segment":   func(in *PreviewAppSetInput) { in.AppsPath = "charts/my.app/v1" },
	"empty namespace prefix defaults":     func(in *PreviewAppSetInput) { in.NamespacePrefix = "" },
	"a numeric namespace prefix":          func(in *PreviewAppSetInput) { in.NamespacePrefix = "1preview" },
	"a hyphenated namespace prefix":       func(in *PreviewAppSetInput) { in.NamespacePrefix = "pr-preview" },
	"gitlab":                              func(in *PreviewAppSetInput) { in.GitProvider = "gitlab" },
	"bitbucket":                           func(in *PreviewAppSetInput) { in.GitProvider = "bitbucket" },
	"empty token secret ref":              func(in *PreviewAppSetInput) { in.TokenSecretRef = "" },
	"a dotted secret name":                func(in *PreviewAppSetInput) { in.TokenSecretRef = "preview.scm.token" },
	"empty dest server defaults":          func(in *PreviewAppSetInput) { in.DestServer = "" },
	"an ssh apps repo URL":                func(in *PreviewAppSetInput) { in.AppsRepoURL = "ssh://git@github.com/acme/shop.git" },
	"a git:// apps repo URL":              func(in *PreviewAppSetInput) { in.AppsRepoURL = "git://github.com/acme/shop.git" },
	"an explicit https dest server":       func(in *PreviewAppSetInput) { in.DestServer = "https://api.cluster.internal" },
	"a repo name with punctuation":        func(in *PreviewAppSetInput) { in.RepoOwner = "a-c_m.e"; in.RepoName = "shop.js" },
	"a prefixed label key":                func(in *PreviewAppSetInput) { in.Labels = map[string]string{"alethia.io/project": "demo"} },
	"an empty label value":                func(in *PreviewAppSetInput) { in.Labels = map[string]string{"alethia.io/x": ""} },
	"a label value at the limit":          func(in *PreviewAppSetInput) { in.Labels = map[string]string{"a": strings.Repeat("v", 63)} },
}

func TestPreviewApplicationSetRefusesUnsafeShapes(t *testing.T) {
	if len(previewRejects) == 0 {
		t.Fatal("no rejection cases — the table would pass vacuously")
	}
	for name, mutate := range previewRejects {
		t.Run(name, func(t *testing.T) {
			in := basePreviewInput()
			mutate(&in)
			out, err := RenderPreviewApplicationSet(in)
			if err == nil {
				t.Fatalf("expected a refusal, got a rendered manifest:\n%s", out)
			}
		})
	}
}

func TestPreviewApplicationSetStillAcceptsValidShapes(t *testing.T) {
	if len(previewAccepts) == 0 {
		t.Fatal("no acceptance cases — the rejection table could be satisfied by refusing everything")
	}
	for name, mutate := range previewAccepts {
		t.Run(name, func(t *testing.T) {
			in := basePreviewInput()
			mutate(&in)
			if _, err := RenderPreviewApplicationSet(in); err != nil {
				t.Fatalf("expected acceptance, got: %v", err)
			}
		})
	}
}

// The guardrails half renders the AppProjects that CONSTRAIN the untrusted app half, so the same
// shapes must be refused there. Only the fields that exist on both inputs are exercised; the
// guardrails-specific ones follow.
func TestPreviewGuardrailsRefusesUnsafeShapes(t *testing.T) {
	cases := map[string]func(*PreviewGuardrailsInput){
		"namespace prefix is a lone dash":  func(in *PreviewGuardrailsInput) { in.NamespacePrefix = "-" },
		"namespace prefix ends in a dash":  func(in *PreviewGuardrailsInput) { in.NamespacePrefix = "preview-" },
		"git provider is unknown":          func(in *PreviewGuardrailsInput) { in.GitProvider = "gitea" },
		"repo owner has a line break":      func(in *PreviewGuardrailsInput) { in.RepoOwner = "acme\n x: y" },
		"guardrails path escapes the root": func(in *PreviewGuardrailsInput) { in.GuardrailsPath = "../../etc" },
		"guardrails path is absolute":      func(in *PreviewGuardrailsInput) { in.GuardrailsPath = "/etc" },
		"label value has a quote":          func(in *PreviewGuardrailsInput) { in.Labels = map[string]string{"a": `v" evil: "x`} },
		"dest server is not a URL":         func(in *PreviewGuardrailsInput) { in.DestServer = "not a url" },
		"a source repo has a line break":   func(in *PreviewGuardrailsInput) { in.AppSourceRepos = []string{"https://a\n  - '*'"} },
		"token secret ref has a slash":     func(in *PreviewGuardrailsInput) { in.TokenSecretRef = "ns/secret" },
	}
	if len(cases) == 0 {
		t.Fatal("no cases — the table would pass vacuously")
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			in := basePreviewGuardrailsInput()
			mutate(&in)
			out, err := RenderPreviewGuardrails(in)
			if err == nil {
				t.Fatalf("expected a refusal, got a rendered manifest:\n%s", out)
			}
		})
	}
}

// TestPreviewNamespacePrefixLeavesRoomForThePRNumber pins the arithmetic behind
// previewPrefixMaxLen rather than the constant, so changing the reservation without changing the
// reasoning fails here.
func TestPreviewNamespacePrefixLeavesRoomForThePRNumber(t *testing.T) {
	prefix := strings.Repeat("a", previewPrefixMaxLen)
	// The namespace arm renders `<prefix>-<pr number>`; seven digits is the reserved budget.
	rendered := prefix + "-" + "1234567"
	if len(rendered) > dns1123LabelMaxLen {
		t.Errorf("a maximum-length prefix plus a seven-digit PR number is %d characters, over Kubernetes' %d",
			len(rendered), dns1123LabelMaxLen)
	}
	if !dns1123Label.MatchString(rendered) {
		t.Errorf("%q is not a valid DNS-1123 label", rendered)
	}
}

// TestPreviewRenderersShareTheAppsPathGuard is the anti-regression for the finding itself: both
// renderers must reject a traversal, and they must do it through the SAME function every other
// site uses, not a local re-implementation that can drift.
func TestPreviewRenderersShareTheAppsPathGuard(t *testing.T) {
	const traversal = "../../etc"

	if err := ValidateAppsPath(traversal); err == nil {
		t.Fatal("ValidateAppsPath itself accepted a traversal — the shared guard is broken")
	}

	app := basePreviewInput()
	app.AppsPath = traversal
	_, appErr := RenderPreviewApplicationSet(app)
	if appErr == nil {
		t.Error("the app-half renderer accepted a traversal apps path")
	}

	rails := basePreviewGuardrailsInput()
	rails.GuardrailsPath = traversal
	_, railsErr := RenderPreviewGuardrails(rails)
	if railsErr == nil {
		t.Error("the guardrails renderer accepted a traversal path")
	}

	// Both messages must NAME THE NORMALISED FORM. That is ValidateAppsPath's distinctive
	// contract — it refuses rather than normalising, and says what the value would have become so
	// the user can see what was actually asked for — and `apps_path_test.go` pins it there. A
	// local re-implementation would almost certainly just say "invalid path", so this substring is
	// the evidence that the shared guard produced the refusal rather than a copy of it.
	for _, err := range []error{appErr, railsErr} {
		if err == nil {
			continue
		}
		if !strings.Contains(err.Error(), "normalises to") {
			t.Errorf("refusal does not carry ValidateAppsPath's normalised-form contract: %v", err)
		}
	}
}
