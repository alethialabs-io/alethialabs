// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
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
	irsaEntry        = regexp.MustCompile(`"([^":]+):[^"]*"`)
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

// templateTrustNamespaces returns every namespace named in a workload-identity trust subject under
// infra/templates/project, resolving ${local.x} against the locals of the same directory. A
// ${var.x} inside a module is skipped: the caller's value is a literal at the call site, which this
// scan reads. A wildcard is not a namespace and is skipped.
func templateTrustNamespaces(t *testing.T) map[string][]string {
	t.Helper()
	root := filepath.Join("..", "..", "..", "infra", "templates", "project")
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
		t.Fatalf("walk %s: %v", root, err)
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
					t.Errorf("%s: trust subject namespace %s names a local this scan cannot resolve", dir, ns)
					return
				}
				ns = v
			}
			if strings.Contains(ns, "${") {
				t.Errorf("%s: trust subject namespace %q is an expression this scan cannot resolve — resolve it here rather than letting it pass unchecked", dir, ns)
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
	}
	return found
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
		if byoReservedNamespaceReason(ns) == "" {
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
