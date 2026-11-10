// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The platformCloudIdentities group is DERIVED (#6551): it is checked against the workload-identity
// trust subjects the project templates create, so a template that starts trusting a service account
// in a new namespace reds here until that namespace is reserved. A namespace whose service account a
// platform cloud identity trusts must not be a namespace a tenant can deploy into — for a namespace
// placement or a BYO chart alike, since both read this one list.

var (
	// The four subject shapes the templates use. Each captures the namespace.
	//   Azure federated credential / Alibaba RRSA:  "system:serviceaccount:<ns>:<sa>"
	//   GKE Workload Identity member:               "...svc.id.goog[<ns>/<sa>]"
	//   AWS IRSA (namespace_service_accounts list): ["<ns>:<sa>", ...]
	trustSubjectSA   = regexp.MustCompile(`system:serviceaccount:([^:"\s]+):`)
	trustSubjectGKE  = regexp.MustCompile(`\.svc\.id\.goog\[([^/\]]+)/`)
	trustSubjectIRSA = regexp.MustCompile(`namespace_service_accounts\s*=\s*\[([^\]]*)\]`)
	// Every assignment of an IRSA subject list, whatever its right-hand side. Each one must be either a
	// list literal (trustSubjectIRSA) or a reference into a locals map (irsaLocalMapRef); anything
	// else fails the scan rather than being skipped.
	irsaAssignment  = regexp.MustCompile(`namespace_service_accounts\s*=\s*(\S[^\n]*)`)
	irsaLocalMapRef = regexp.MustCompile(`^local\.([a-z0-9_]+)\.([a-z0-9_]+)\s*$`)
	irsaEntry       = regexp.MustCompile(`"([^":]+):[^"]*"`)
	// A `local.<name> = "<value>"` definition, to resolve a namespace written as ${local.<name>}.
	tfLocalString = regexp.MustCompile(`(?m)^\s*([a-z0-9_]+)\s*=\s*"([^"$]*)"`)
	tfLocalRef    = regexp.MustCompile(`^\$\{local\.([a-z0-9_]+)\}$`)
)

// stripTfComments drops `#` and `//` comment lines, so a subject quoted in a comment is not read as
// one the template creates.
func stripTfComments(src string) string {
	var out []string
	for _, line := range strings.Split(src, "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "#") || strings.HasPrefix(t, "//") {
			continue
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

// tfLocalMapList returns the body of the list `key = [ ... ]` inside the `name = { ... }` map in src,
// and whether it was found. Brace-matched, so a nested map does not end the block early.
func tfLocalMapList(src, name, key string) (string, bool) {
	start := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(name) + `\s*=\s*\{`).FindStringIndex(src)
	if start == nil {
		return "", false
	}
	depth, end := 0, -1
	for i := start[1] - 1; i < len(src); i++ {
		switch src[i] {
		case '{':
			depth++
		case '}':
			depth--
		}
		if depth == 0 {
			end = i
			break
		}
	}
	if end < 0 {
		return "", false
	}
	m := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(key) + `\s*=\s*\[([^\]]*)\]`).FindStringSubmatch(src[start[1]:end])
	if m == nil {
		return "", false
	}
	return m[1], true
}

// templateTrustNamespaces returns every namespace named in a workload-identity trust subject under
// infra/templates/project, resolving ${local.x} against the locals of the same directory. A
// ${var.x} inside a module is skipped: the caller's value is a literal at the call site, which this
// scan reads. A wildcard is not a namespace and is skipped.
func templateTrustNamespaces(t *testing.T) map[string][]string {
	t.Helper()
	return templateTrustNamespacesUnder(t, filepath.Join("..", "..", "..", "infra", "templates", "project"))
}

// templateTrustNamespacesUnder is templateTrustNamespaces over the template tree at root. Every subject
// it cannot read is a test failure, never a skip.
func templateTrustNamespacesUnder(t *testing.T, root string) map[string][]string {
	t.Helper()
	found, problems, err := scanTrustNamespaces(root)
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	for _, p := range problems {
		t.Error(p)
	}
	return found
}

// scanTrustNamespaces reads every workload-identity trust subject under root: the namespaces they
// name (namespace → directories), and a problem for each subject the scan cannot resolve.
func scanTrustNamespaces(root string) (map[string][]string, []string, error) {
	var problems []string
	files := map[string][]string{} // dir → sources
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".tf") {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		files[filepath.Dir(path)] = append(files[filepath.Dir(path)], stripTfComments(string(raw)))
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	found := map[string][]string{} // namespace → where
	for dir, srcs := range files {
		all := strings.Join(srcs, "\n")
		locals := map[string]string{}
		for _, m := range tfLocalString.FindAllStringSubmatch(all, -1) {
			locals[m[1]] = m[2]
		}
		add := func(ns string) {
			ns = strings.TrimSpace(ns)
			if strings.HasPrefix(ns, "${var.") || ns == "*" || ns == "" {
				return
			}
			if m := tfLocalRef.FindStringSubmatch(ns); m != nil {
				v, ok := locals[m[1]]
				if !ok {
					problems = append(problems, fmt.Sprintf("%s: trust subject namespace %s names a local this scan cannot resolve", dir, ns))
					return
				}
				ns = v
			}
			if strings.Contains(ns, "${") {
				problems = append(problems, fmt.Sprintf("%s: trust subject namespace %q is an expression this scan cannot resolve — resolve it here rather than letting it pass unchecked", dir, ns))
				return
			}
			found[ns] = append(found[ns], dir)
		}
		for _, m := range trustSubjectSA.FindAllStringSubmatch(all, -1) {
			add(m[1])
		}
		for _, m := range trustSubjectGKE.FindAllStringSubmatch(all, -1) {
			add(m[1])
		}
		for _, list := range trustSubjectIRSA.FindAllStringSubmatch(all, -1) {
			for _, e := range irsaEntry.FindAllStringSubmatch(list[1], -1) {
				add(e[1])
			}
		}
		// The subjects may instead live in a locals map of lists, read by reference
		// (`namespace_service_accounts = local.<map>.<key>`, #6556): resolve each reference to the
		// "<ns>:<sa>" entries of that key's list. An assignment of any other shape fails the scan.
		for _, m := range irsaAssignment.FindAllStringSubmatch(all, -1) {
			rhs := strings.TrimSpace(m[1])
			if strings.HasPrefix(rhs, "[") {
				continue // a list literal, read above
			}
			ref := irsaLocalMapRef.FindStringSubmatch(rhs)
			if ref == nil {
				problems = append(problems, fmt.Sprintf("%s: namespace_service_accounts = %s is neither a list literal nor local.<map>.<key>; the scan cannot read it", dir, rhs))
				continue
			}
			entries, ok := tfLocalMapList(all, ref[1], ref[2])
			if !ok {
				problems = append(problems, fmt.Sprintf("%s: namespace_service_accounts = %s names a locals map entry this scan cannot find", dir, rhs))
				continue
			}
			for _, e := range irsaEntry.FindAllStringSubmatch(entries, -1) {
				add(e[1])
			}
		}
	}
	return found, problems, nil
}

// TestByoReserved_EveryTemplateTrustSubjectNamespaceIsReserved is the guard: every namespace a template
// trust subject names is reserved by SOME group (and so refused to a placement and to a BYO chart).
func TestByoReserved_EveryTemplateTrustSubjectNamespaceIsReserved(t *testing.T) {
	found := templateTrustNamespaces(t)
	if len(found) < 5 {
		t.Fatalf("only %d trust-subject namespaces found under infra/templates/project — the scan matched nothing", len(found))
	}
	for _, want := range []string{"fluent-bit", "external-dns", "default"} {
		if _, ok := found[want]; !ok {
			t.Fatalf("the scan did not find %q, which the templates trust today — it is reading the wrong shapes", want)
		}
	}
	for ns, where := range found {
		if byoReservedNamespaceReason(ns) == "" && ByoNewlyReservedNamespaceReason(ns) == "" {
			t.Errorf("namespace %q is trusted by a workload-identity subject in %v but is on no reserved list — add it to the platformCloudIdentities group of byo_reserved_namespaces.json", ns, where)
		}
	}
}

// TestByoReserved_PlatformCloudIdentitiesAreAllTrustSubjects is the other direction: the group names
// only namespaces the templates actually trust, so an entry cannot outlive its template.
func TestByoReserved_PlatformCloudIdentitiesAreAllTrustSubjects(t *testing.T) {
	found := templateTrustNamespaces(t)
	group := byoReservedGroup(t, "platformCloudIdentities")
	var missing []string
	for _, ns := range group {
		if _, ok := found[ns]; !ok {
			missing = append(missing, ns)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("platformCloudIdentities lists %v, which no template trust subject names any more — remove them", missing)
	}
	derived := make([]string, 0, len(found))
	for ns := range found {
		derived = append(derived, ns)
	}
	if got, want := sortedSet(group), sortedSet(derived); strings.Join(got, ",") != strings.Join(want, ",") {
		// Not a failure on its own: a trust namespace may be reserved by another group (the guard above
		// is what must hold). Reported so a reader sees the two sets side by side.
		t.Logf("platformCloudIdentities %v; template trust namespaces %v", got, want)
	}
}

// writeTf writes files (relative path → source) under a fresh template root, for the scan tests.
func writeTf(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for rel, src := range files {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(src), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// TestTrustScan_ReadsIRSASubjectsFromALocalsMap (#6556): the AWS subjects may be written inline or moved
// into `local.<map>.<key>` lists. Both shapes must derive the SAME namespaces, so the list does not go
// red, or silently drop a namespace, depending on which form the template uses.
func TestTrustScan_ReadsIRSASubjectsFromALocalsMap(t *testing.T) {
	inline := writeTf(t, map[string]string{"aws/irsa.tf": `
locals {
  karpenter_namespace = "karpenter"
  ecr_build_namespace = "alethia-build"
}
module "a" {
  namespace_service_accounts = ["fluent-bit:fluent-bit"]
}
module "b" {
  namespace_service_accounts = ["${local.karpenter_namespace}:karpenter"]
}
module "c" {
  namespace_service_accounts = ["${local.ecr_build_namespace}:kaniko-builder", "default:alethia-app"]
}
`})
	mapped := writeTf(t, map[string]string{"aws/irsa.tf": `
locals {
  karpenter_namespace = "karpenter"
  ecr_build_namespace = "alethia-build"
}
locals {
  irsa_service_accounts = {
    fluentbit = ["fluent-bit:fluent-bit"]
    karpenter = ["${local.karpenter_namespace}:karpenter"]
    ecr_build = ["${local.ecr_build_namespace}:kaniko-builder", "default:alethia-app"]
  }
}
module "a" {
  namespace_service_accounts = local.irsa_service_accounts.fluentbit
}
module "b" {
  namespace_service_accounts = local.irsa_service_accounts.karpenter
}
module "c" {
  namespace_service_accounts = local.irsa_service_accounts.ecr_build
}
`})
	keys := func(root string) string {
		found, problems, err := scanTrustNamespaces(root)
		if err != nil || len(problems) > 0 {
			t.Fatalf("scan %s: err=%v problems=%v", root, err, problems)
		}
		var out []string
		for ns := range found {
			out = append(out, ns)
		}
		sort.Strings(out)
		return strings.Join(out, ",")
	}
	want := "alethia-build,default,fluent-bit,karpenter"
	if got := keys(inline); got != want {
		t.Errorf("inline subjects derived %s, want %s", got, want)
	}
	if got := keys(mapped); got != want {
		t.Errorf("locals-map subjects derived %s, want %s", got, want)
	}
}

// TestTrustScan_FailsClosedOnAnUnreadableSubject: a subject list the scan cannot resolve — a var, an
// unknown map key, an unknown local — is a problem, never a silent skip.
func TestTrustScan_FailsClosedOnAnUnreadableSubject(t *testing.T) {
	for name, src := range map[string]string{
		"a var":            `module "a" { namespace_service_accounts = var.subjects }`,
		"an unknown key":   "locals {\n  irsa_service_accounts = {\n    a = [\"x:y\"]\n  }\n}\nmodule \"a\" {\n  namespace_service_accounts = local.irsa_service_accounts.b\n}\n",
		"an unknown local": `module "a" { namespace_service_accounts = ["${local.nowhere}:sa"] }`,
		"a function call":  `module "a" { namespace_service_accounts = concat(["a:b"], ["c:d"]) }`,
	} {
		t.Run(name, func(t *testing.T) {
			_, problems, err := scanTrustNamespaces(writeTf(t, map[string]string{"x/main.tf": src}))
			if err != nil {
				t.Fatal(err)
			}
			if len(problems) == 0 {
				t.Errorf("an unreadable subject passed the scan silently")
			}
		})
	}
}
