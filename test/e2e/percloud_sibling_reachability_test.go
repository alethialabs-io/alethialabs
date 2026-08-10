// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The THIRD reachability guard, and the one the first two are structurally blind to.
//
// TestScenarioEnablesReachTheNightly greps harness files for the LITERAL regexp
// `ALETHIA_E2E_[A-Z0-9_]+`. But t2ArgoEnvForProvider COMPOSES its per-cloud name at runtime —
// `base + "_" + strings.ToUpper(provider)` (t2_argo_repos.go) — so `ALETHIA_E2E_KEYLESS_DB_ENGINE_VERSION_GCP`
// appears in no file, and no literal-scanning guard can ever see it.
//
// The gap that hid there is not hypothetical, and it is worse than an unwired scenario:
// docs/testing/e2e-nightly-enablement.md tells a maintainer to "use the per-cloud siblings
// (E2E_KEYLESS_DB_ENGINE_VERSION_GCP, and so on)", e2e-nightly.yml repeats the instruction in its own
// comment, and the doc also says that value is REQUIRED with no default. A maintainer who follows the
// documentation sets a repo variable the harness can never read, and the leg dies in seconds claiming
// a required variable is unset. Following the docs correctly is the failure path.
//
// So: t2ArgoEnvForProvider PROMISES per-cloud resolution for every base it is called with, and the
// workflow delivers it for six. This guard makes promise and delivery agree by forcing every base to
// be one of two things — forwarded, or explicitly declared flat-only with a reason. Exactly the shape
// of nightlyExemptEnv: excluding a base is a deliberate, reviewed act, not something that happens by
// forgetting.
//
// The bases are collected by PARSING the package (go/ast), not by grepping, because the whole point is
// that the interesting name is never written down. A new call site is picked up for free.
package e2e

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// perCloudSiblingWave records, per base, which clouds the workflow is expected to forward a sibling
// for. A base absent from BOTH this map and perCloudSiblingFlatOnly fails the guard.
//
// The wave scoping is the workflow's own, stated at e2e-nightly.yml: the A0.6 repo proof runs on
// gcp + azure "and alibaba/hetzner add their siblings in their own waves". Keyless DB is the same
// shape — its engine version, instance class and images are genuinely per-cloud (a Cloud SQL version
// string is not an RDS one), and the docs already tell maintainers to set them per cloud.
var perCloudSiblingWave = map[string][]string{
	"ALETHIA_E2E_ARGO_APPS_REPO":            {"GCP", "AZURE"},
	"ALETHIA_E2E_ARGO_BYO_CHART_REPO":       {"GCP", "AZURE"},
	"ALETHIA_E2E_ARGO_BYO_CHART_REVISION":   {"GCP", "AZURE"},
	"ALETHIA_E2E_KEYLESS_DB_ENGINE":         {"GCP", "AZURE"},
	"ALETHIA_E2E_KEYLESS_DB_ENGINE_VERSION": {"GCP", "AZURE"},
	"ALETHIA_E2E_KEYLESS_DB_INSTANCE_CLASS": {"GCP", "AZURE"},
	"ALETHIA_E2E_KEYLESS_DB_IMAGE":          {"GCP", "AZURE"},
	"ALETHIA_E2E_KEYLESS_DB_CLIENT_IMAGE":   {"GCP", "AZURE"},
}

// perCloudSiblingFlatOnly are the bases whose value does NOT vary by cloud, so the shared flat
// variable serves every leg and no sibling is expected. Each needs a reason, because "I forgot" and
// "it genuinely does not vary" are indistinguishable from the outside — which is how the keyless
// siblings came to be documented but unreachable.
//
// t2ArgoEnvForProvider still RESOLVES a sibling for these if one is somehow present in the
// environment; this map only records that the nightly is not expected to forward one.
var perCloudSiblingFlatOnly = map[string]string{
	// Repo layout, not cloud shape: the chart lives at the same path in the same repo whichever cloud
	// consumes it. Note docs/testing/e2e-nightly-enablement.md used to promise `E2E_ARGO_BYO_CHART_*_GCP`
	// with a glob that covered these two; the glob was narrowed to the three that are actually forwarded.
	"ALETHIA_E2E_ARGO_BYO_CHART_PATH":      "a path inside the chart repo — identical for every cloud",
	"ALETHIA_E2E_ARGO_BYO_CHART_NAMESPACE": "the in-cluster namespace the BYO chart installs into — not a cloud property",

	// BYO-IaC: one public repo holds every cloud's module, selected by PATH, and the default path
	// already interpolates the provider (byoIacDefaultPathPrefix + provider). So the per-cloud
	// dimension is expressed in the DEFAULT, not in a sibling.
	"ALETHIA_E2E_BYO_IAC_REPO":         "one repo carries every cloud's module; the cloud is selected by path",
	"ALETHIA_E2E_BYO_IAC_REF":          "a git ref in that one repo — the same commit is proven on every cloud",
	"ALETHIA_E2E_BYO_IAC_PATH":         "its default already interpolates the provider (iac/drift/<cloud>), so the per-cloud dimension is in the default",
	"ALETHIA_E2E_BYO_IAC_BLOCKED_PATH": "one shared negative fixture (iac/blocked) proves the refusal identically on every cloud",

	// Fabric demo (#845): one public enterprise-demo repo, and the tier→namespace map is what the
	// overlays themselves declare — so it is a property of the repo, not of the cloud. The point of the
	// acceptance gate is that the SAME demo lands on all four clouds; a per-cloud override would weaken
	// the claim rather than enable it.
	"ALETHIA_E2E_FABRIC_DEMO_REPO":     "one public enterprise-demo repo; proving the same demo on every cloud is the acceptance criterion",
	"ALETHIA_E2E_FABRIC_DEMO_OVERLAYS": "the tier→namespace map is what the overlays declare, a repo property; #845 requires the same tiers everywhere",
	"ALETHIA_E2E_FABRIC_DEMO_VCLUSTER": "names which of those tiers is also vcluster-placed — same answer on every cloud",

	// Cross-account secrets + registry: these are per-cloud by nature, but the WHOLE scenario is
	// per-cloud already — the workflow sets the flat var while dispatching one cloud at a time, and the
	// account-B stacks for gcp/azure are not written yet (#1268). A sibling wave belongs with those
	// stacks, not before them.
	"ALETHIA_E2E_SECRETS_XACCT_ACCOUNT":       "scenario is dispatched one cloud at a time; the gcp/azure account-B stacks are unwritten (#1268)",
	"ALETHIA_E2E_SECRETS_XACCT_REGION":        "as above (#1268)",
	"ALETHIA_E2E_SECRETS_XACCT_ROLE_ARN":      "as above (#1268)",
	"ALETHIA_E2E_SECRETS_XACCT_OIDC_ARN":      "as above (#1268)",
	"ALETHIA_E2E_SECRETS_XACCT_PROJECT_ID":    "as above (#1268)",
	"ALETHIA_E2E_SECRETS_XACCT_VAULT_URL":     "as above (#1268)",
	"ALETHIA_E2E_SECRETS_XACCT_EXTERNAL_ID":   "as above (#1268)",
	"ALETHIA_E2E_SECRETS_XACCT_REMOTE_KEY":    "as above (#1268)",
	"ALETHIA_E2E_SECRETS_XACCT_EXPECT_SHA256": "as above (#1268)",
	"ALETHIA_E2E_XACCT_REGISTRY_ACCOUNT":      "registry xacct is deliberately not set today; a sibling wave belongs with its enablement",
	"ALETHIA_E2E_XACCT_REGISTRY_PROJECT_ID":   "as above",
	"ALETHIA_E2E_XACCT_REGISTRY_REGION":       "as above",
	"ALETHIA_E2E_XACCT_REGISTRY_ROLE_ARN":     "as above",
	"ALETHIA_E2E_XACCT_REGISTRY_READER_SA":    "as above",
	"ALETHIA_E2E_XACCT_REGISTRY_CLIENT_ID":    "as above",
	"ALETHIA_E2E_XACCT_REGISTRY_HOST":         "as above",
	"ALETHIA_E2E_XACCT_REGISTRY_IMAGE":        "as above",
}

// TestPerCloudSiblingsReachTheNightly is the guard. For every base passed to t2ArgoEnvForProvider it
// requires either a declared wave whose siblings the workflow forwards, or an explicit flat-only
// reason. Neither ⇒ fail, naming the base and the file that reads it.
func TestPerCloudSiblingsReachTheNightly(t *testing.T) {
	dir := e2ePackageDir(t)
	wf, err := os.ReadFile(filepath.Join(dir, "..", "..", ".github", "workflows", "e2e-nightly.yml"))
	if err != nil {
		t.Fatalf("read e2e-nightly.yml: %v", err)
	}
	workflow := string(wf)

	bases := perCloudSiblingBases(t, dir)
	if len(bases) == 0 {
		t.Fatal("parsed zero t2ArgoEnvForProvider call sites — the guard would pass having proven nothing")
	}
	t.Logf("resolved %d per-cloud sibling bases from the package AST", len(bases))

	var undeclared, unforwarded []string
	for _, base := range sortedBaseNames(bases) {
		file := bases[base]
		wave, declared := perCloudSiblingWave[base]
		_, flat := perCloudSiblingFlatOnly[base]

		switch {
		case declared && flat:
			t.Errorf("%s is in BOTH perCloudSiblingWave and perCloudSiblingFlatOnly — it cannot be per-cloud and flat-only at once", base)
		case !declared && !flat:
			undeclared = append(undeclared, base+"  (read by "+file+")")
		case declared:
			for _, cloud := range wave {
				if !strings.Contains(workflow, base+"_"+cloud) {
					unforwarded = append(unforwarded, base+"_"+cloud+"  (read by "+file+")")
				}
			}
		}
	}

	if len(undeclared) > 0 {
		t.Errorf("t2ArgoEnvForProvider promises a per-cloud sibling for these bases, but nothing says whether the\n"+
			"nightly should forward one. Add each to perCloudSiblingWave (with the clouds) or to\n"+
			"perCloudSiblingFlatOnly (with the reason it does not vary by cloud):\n  %s",
			strings.Join(undeclared, "\n  "))
	}
	if len(unforwarded) > 0 {
		t.Errorf("these per-cloud siblings are DECLARED but e2e-nightly.yml never forwards them, so a maintainer who\n"+
			"sets the repo variable gets no effect — the harness composes the name at runtime, so no\n"+
			"literal-scanning guard can see this. Add `ALETHIA_E2E_<BASE>_<CLOUD>: ${{ vars.E2E_<BASE>_<CLOUD> }}`\n"+
			"to the T2 step's env, or move the base to perCloudSiblingFlatOnly:\n  %s",
			strings.Join(unforwarded, "\n  "))
	}
}

// TestPerCloudSiblingAllowlistsAreNotStale keeps both maps honest: an entry for a base no call site
// passes any more is dead weight that makes the next reader trust a guarantee nobody enforces.
func TestPerCloudSiblingAllowlistsAreNotStale(t *testing.T) {
	bases := perCloudSiblingBases(t, e2ePackageDir(t))
	for _, m := range []struct {
		name    string
		entries map[string]string
	}{
		{"perCloudSiblingFlatOnly", perCloudSiblingFlatOnly},
	} {
		for base, reason := range m.entries {
			if _, live := bases[base]; !live {
				t.Errorf("%s lists %q, which no t2ArgoEnvForProvider call site passes any more — drop it (reason on file: %q)", m.name, base, reason)
			}
			if strings.TrimSpace(reason) == "" {
				t.Errorf("%s[%q] has an empty reason — the reason is the whole point of the allowlist", m.name, base)
			}
		}
	}
	for base := range perCloudSiblingWave {
		if _, live := bases[base]; !live {
			t.Errorf("perCloudSiblingWave lists %q, which no t2ArgoEnvForProvider call site passes any more — drop it", base)
		}
	}
}

// perCloudSiblingBases parses every non-test .go file in the harness package, finds each
// t2ArgoEnvForProvider call, and resolves its first argument to the env-var string it names. Returns
// base -> the file that reads it.
//
// Args[0] is always a package-level `env*` const in this package, so resolving means looking the
// identifier up in the const table collected from the same parse. A literal is accepted too. Anything
// else is a hard failure rather than a silent skip: a base the guard cannot resolve is a base the
// guard does not cover, which is precisely the blindness this file exists to remove.
func perCloudSiblingBases(t *testing.T, dir string) map[string]string {
	t.Helper()
	fset := token.NewFileSet()
	pkg, err := parser.ParseDir(fset, dir, func(fi os.FileInfo) bool {
		return !strings.HasSuffix(fi.Name(), "_test.go")
	}, 0)
	if err != nil {
		t.Fatalf("parse the e2e harness package: %v", err)
	}

	consts := map[string]string{}
	var files []*ast.File
	for _, p := range pkg {
		for _, f := range p.Files {
			files = append(files, f)
		}
	}
	if len(files) == 0 {
		t.Fatal("parsed no harness files — every T2 scenario source is behind a build tag the parser should still read")
	}
	for _, f := range files {
		for _, decl := range f.Decls {
			gd, ok := decl.(*ast.GenDecl)
			if !ok || gd.Tok != token.CONST {
				continue
			}
			for _, spec := range gd.Specs {
				vs, ok := spec.(*ast.ValueSpec)
				if !ok {
					continue
				}
				for i, name := range vs.Names {
					if i >= len(vs.Values) {
						continue
					}
					if lit, ok := vs.Values[i].(*ast.BasicLit); ok && lit.Kind == token.STRING {
						if v, err := strconv.Unquote(lit.Value); err == nil {
							consts[name.Name] = v
						}
					}
				}
			}
		}
	}

	bases := map[string]string{}
	for _, f := range files {
		file := filepath.Base(fset.Position(f.Pos()).Filename)
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			id, ok := call.Fun.(*ast.Ident)
			if !ok || id.Name != "t2ArgoEnvForProvider" || len(call.Args) == 0 {
				return true
			}
			switch arg := call.Args[0].(type) {
			case *ast.Ident:
				v, ok := consts[arg.Name]
				if !ok {
					t.Errorf("%s: t2ArgoEnvForProvider's base %q is not a resolvable package const — the guard cannot cover it", file, arg.Name)
					return true
				}
				if _, seen := bases[v]; !seen {
					bases[v] = file
				}
			case *ast.BasicLit:
				if v, err := strconv.Unquote(arg.Value); err == nil {
					if _, seen := bases[v]; !seen {
						bases[v] = file
					}
				}
			default:
				t.Errorf("%s: t2ArgoEnvForProvider called with a base the guard cannot resolve statically (%T) — "+
					"keep it a const or a literal so per-cloud reachability stays checkable", file, arg)
			}
			return true
		})
	}
	return bases
}

// e2ePackageDir locates this package's directory.
func e2ePackageDir(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Dir(thisFile)
}

// sortedBaseNames gives the guard a deterministic report order. (The package already has a
// sortedKeys for map[string]bool; this one is for the base→file map.)
func sortedBaseNames(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
