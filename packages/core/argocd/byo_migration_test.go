// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"io"
	"reflect"
	"strings"
	"testing"
)

// TestLiveApplicationProject reads spec.project, answers "" for an absent Application, reports a
// failed read, and refuses a name that is not a Kubernetes name without running kubectl.
func TestLiveApplicationProject(t *testing.T) {
	s := newKubectlStub(t, 0, stubRule{Match: "get applications.argoproj.io addon-pay -n argocd --ignore-not-found", Stdout: "infra\n"})
	if got, err := LiveApplicationProject("addon-pay"); err != nil || got != "infra" {
		t.Errorf("LiveApplicationProject = %q, %v; want infra", got, err)
	}
	if got, err := LiveApplicationProject("addon-absent"); err != nil || got != "" {
		t.Errorf("an absent Application = %q, %v; want \"\" and no error", got, err)
	}
	before := len(s.calls())
	if _, err := LiveApplicationProject("bad name; rm -rf /"); err == nil {
		t.Error("a non-Kubernetes name must be refused")
	}
	if len(s.calls()) != before {
		t.Error("kubectl ran for a refused name")
	}

	newKubectlStub(t, 1)
	if _, err := LiveApplicationProject("addon-pay"); err == nil {
		t.Error("a failed read must be reported")
	}
}

// TestReleaseLegacyByoNamespaceLabels covers each branch: ours (managed-by, the owner, and every
// commonLabels pair whose value is ours), another environment's (nothing), a managed-by with another
// value (kept), a classification label with another value (kept), neither, a refused input, a failed
// read, an unparsable read and a failed label edit.
func TestReleaseLegacyByoNamespaceLabels(t *testing.T) {
	ns := func(labels string) string { return `{"metadata":{"name":"default","labels":` + labels + `}}` }
	ours := map[string]string{
		"alethia.io/project-id":     "p1",
		"alethia.io/environment-id": "env-1",
		"alethia.io/team":           "payments",
		"alethia.io/cost-center":    "cc-7",
	}
	for _, tc := range []struct {
		name, labels string
		want         []string
	}{
		{"ours", `{"kubernetes.io/metadata.name":"default","alethia.io/managed-by":"byo-charts","alethia.io/environment-id":"env-1","alethia.io/project-id":"p1","alethia.io/team":"payments","team":"x"}`,
			[]string{"alethia.io/environment-id", "alethia.io/managed-by", "alethia.io/project-id", "alethia.io/team"}},
		{"another environment's", `{"alethia.io/managed-by":"byo-charts","alethia.io/environment-id":"env-2","alethia.io/project-id":"p1"}`, nil},
		{"managed-by someone else", `{"alethia.io/managed-by":"helm"}`, nil},
		{"managed-by someone else, owner ours", `{"alethia.io/managed-by":"helm","alethia.io/environment-id":"env-1"}`, []string{"alethia.io/environment-id"}},
		{"a classification label with another value", `{"alethia.io/managed-by":"byo-charts","alethia.io/cost-center":"cc-9"}`, []string{"alethia.io/managed-by"}},
		{"only the owner", `{"alethia.io/environment-id":"env-1"}`, []string{"alethia.io/environment-id"}},
		{"neither", `{"kubernetes.io/metadata.name":"default"}`, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newKubectlStub(t, 0, stubRule{Match: "get namespace default -o json", Stdout: ns(tc.labels)})
			got, err := ReleaseLegacyByoNamespaceLabels("default", "env-1", ours, io.Discard)
			if err != nil {
				t.Fatalf("err = %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("removed = %v, want %v", got, tc.want)
			}
			var labelCalls []string
			for _, c := range s.calls() {
				if strings.HasPrefix(c, "label ") {
					labelCalls = append(labelCalls, c)
				}
			}
			if len(tc.want) == 0 {
				if len(labelCalls) != 0 {
					t.Errorf("unexpected label edit: %v", labelCalls)
				}
				return
			}
			args := make([]string, len(tc.want))
			for i, k := range tc.want {
				args[i] = k + "-"
			}
			if want := []string{"label namespace default " + strings.Join(args, " ")}; !reflect.DeepEqual(labelCalls, want) {
				t.Errorf("label calls = %v, want %v", labelCalls, want)
			}
		})
	}

	t.Run("refused input", func(t *testing.T) {
		s := newKubectlStub(t, 0)
		for _, in := range [][2]string{{"bad ns", "env-1"}, {"default", ""}} {
			if _, err := ReleaseLegacyByoNamespaceLabels(in[0], in[1], nil, io.Discard); err == nil {
				t.Errorf("ReleaseLegacyByoNamespaceLabels(%q, %q) must be refused", in[0], in[1])
			}
		}
		if len(s.calls()) != 0 {
			t.Errorf("kubectl ran for refused input: %v", s.calls())
		}
	})
	t.Run("a key that is not a label key", func(t *testing.T) {
		s := newKubectlStub(t, 0, stubRule{Match: "get namespace default -o json", Stdout: ns(`{"bad key;x":"v"}`)})
		if _, err := ReleaseLegacyByoNamespaceLabels("default", "env-1", map[string]string{"bad key;x": "v"}, io.Discard); err == nil {
			t.Error("a key that is not a label key must be refused")
		}
		for _, c := range s.calls() {
			if strings.HasPrefix(c, "label ") {
				t.Errorf("a label edit ran: %s", c)
			}
		}
	})
	t.Run("failed read", func(t *testing.T) {
		newKubectlStub(t, 1)
		if _, err := ReleaseLegacyByoNamespaceLabels("default", "env-1", nil, io.Discard); err == nil {
			t.Error("a failed read must be reported")
		}
	})
	t.Run("unparsable read", func(t *testing.T) {
		newKubectlStub(t, 0, stubRule{Match: "get namespace default -o json", Stdout: "not json"})
		if _, err := ReleaseLegacyByoNamespaceLabels("default", "env-1", nil, io.Discard); err == nil {
			t.Error("an unparsable read must be reported")
		}
	})
	t.Run("failed edit", func(t *testing.T) {
		newKubectlStub(t, 0,
			stubRule{Match: "get namespace default -o json", Stdout: ns(`{"alethia.io/managed-by":"byo-charts"}`)},
			stubRule{Match: "label namespace default", Exit: 1})
		if _, err := ReleaseLegacyByoNamespaceLabels("default", "env-1", nil, io.Discard); err == nil {
			t.Error("a failed label edit must be reported")
		}
	})
}
