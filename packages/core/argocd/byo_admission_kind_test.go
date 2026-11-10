// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build byo_admission_kind

// The BYO admission policy against a REAL API server (#6495). The unit tests in byo_admission_test.go
// render the policy and pin its CEL text; they cannot execute it, because no CEL evaluator is in this
// module's graph. The enforce policy is `failurePolicy: Fail`, so an expression that errors at runtime
// would refuse every Service, Secret and Ingress write in every new BYO namespace — the platform's
// own included. This test is the evidence that it does not.
//
// It runs against whatever cluster the current kubeconfig names, and is meant for a throwaway kind
// cluster: .github/workflows/byo-admission-kind.yml creates one at the oldest supported Kubernetes
// minor and runs
//
//	go test -tags byo_admission_kind -run TestByoAdmissionKind -count=1 -v ./argocd
//
// It applies the cluster-scoped policies and creates namespaces and objects. Do not point it at a
// cluster anyone uses.

package argocd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

// kubectlIn runs kubectl with stdin and returns stdout, stderr and the error.
func kubectlIn(stdin string, args ...string) (string, string, error) {
	cmd := exec.Command("kubectl", args...)
	cmd.Stdin = strings.NewReader(stdin)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	return out.String(), errb.String(), err
}

// mustKubectl runs kubectl and fails the test on error.
func mustKubectl(t *testing.T, stdin string, args ...string) string {
	t.Helper()
	out, errOut, err := kubectlIn(stdin, args...)
	if err != nil {
		t.Fatalf("kubectl %s: %v\n%s", strings.Join(args, " "), err, errOut)
	}
	return out
}

// summary appends a line to the job summary when running in Actions, and logs it either way.
func summary(t *testing.T, format string, args ...any) {
	t.Helper()
	line := fmt.Sprintf(format, args...)
	t.Log(line)
	if p := os.Getenv("GITHUB_STEP_SUMMARY"); p != "" {
		if f, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o600); err == nil {
			fmt.Fprintln(f, line)
			f.Close()
		}
	}
}

// violating are the four objects the rules refuse, one per rule, in rule order.
func violating() []struct{ rule, manifest string } {
	return []struct{ rule, manifest string }{
		{"service-exposure", `{"apiVersion":"v1","kind":"Service","metadata":{"name":"lb"},"spec":{"type":"LoadBalancer","selector":{"app":"x"},"ports":[{"port":80}]}}`},
		{"service-external-ips", `{"apiVersion":"v1","kind":"Service","metadata":{"name":"eip"},"spec":{"selector":{"app":"x"},"ports":[{"port":80}],"externalIPs":["203.0.113.7"]}}`},
		{"service-account-token-secret", `{"apiVersion":"v1","kind":"Secret","metadata":{"name":"tok","annotations":{"kubernetes.io/service-account.name":"default"}},"type":"kubernetes.io/service-account-token"}`},
		{"ingress-snippet-annotation", `{"apiVersion":"networking.k8s.io/v1","kind":"Ingress","metadata":{"name":"snip","annotations":{"nginx.ingress.kubernetes.io/configuration-snippet":"return 200;"}},"spec":{"defaultBackend":{"service":{"name":"web","port":{"number":80}}}}}`},
	}
}

// ordinary are objects an ordinary chart, and the platform itself, write into a BYO namespace.
func ordinary() []struct{ what, manifest string } {
	tls := `"data":{"tls.crt":"Y2VydA==","tls.key":"a2V5"}`
	return []struct{ what, manifest string }{
		{"a Deployment", `{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web"},"spec":{"replicas":0,"selector":{"matchLabels":{"app":"web"}},"template":{"metadata":{"labels":{"app":"web"}},"spec":{"containers":[{"name":"c","image":"registry.k8s.io/pause:3.9"}]}}}}`},
		{"a ClusterIP Service", `{"apiVersion":"v1","kind":"Service","metadata":{"name":"web"},"spec":{"type":"ClusterIP","selector":{"app":"web"},"ports":[{"port":80}]}}`},
		{"a Service with no type", `{"apiVersion":"v1","kind":"Service","metadata":{"name":"web2"},"spec":{"selector":{"app":"web"},"ports":[{"port":80}]}}`},
		{"a headless Service", `{"apiVersion":"v1","kind":"Service","metadata":{"name":"web-headless"},"spec":{"clusterIP":"None","selector":{"app":"web"},"ports":[{"port":80}]}}`},
		{"an ExternalName Service", `{"apiVersion":"v1","kind":"Service","metadata":{"name":"ext"},"spec":{"type":"ExternalName","externalName":"example.com"}}`},
		{"an Opaque Secret", `{"apiVersion":"v1","kind":"Secret","metadata":{"name":"plain"},"type":"Opaque","stringData":{"k":"v"}}`},
		{"a Secret with no type", `{"apiVersion":"v1","kind":"Secret","metadata":{"name":"untyped"},"stringData":{"k":"v"}}`},
		{"a Secret shaped as ExternalSecrets writes it", `{"apiVersion":"v1","kind":"Secret","metadata":{"name":"api-database-primary","labels":{"reconcile.external-secrets.io/managed":"true","alethia.io/byo-binding":"true"},"annotations":{"reconcile.external-secrets.io/data-hash":"0123abcd"}},"type":"Opaque","data":{"password":"cGFzcw=="}}`},
		{"the add-on secret-knob Secret shape", `{"apiVersion":"v1","kind":"Secret","metadata":{"name":"addon-secrets","labels":{"alethia.io/managed-by":"alethia"}},"type":"Opaque","stringData":{"adminPassword":"x"}}`},
		{"a TLS Secret", `{"apiVersion":"v1","kind":"Secret","metadata":{"name":"tls"},"type":"kubernetes.io/tls",` + tls + `}`},
		{"a Secret shaped as cert-manager writes it", `{"apiVersion":"v1","kind":"Secret","metadata":{"name":"cm-tls","annotations":{"cert-manager.io/certificate-name":"web","cert-manager.io/issuer-name":"letsencrypt"},"labels":{"controller.cert-manager.io/fao":"true"}},"type":"kubernetes.io/tls",` + tls + `}`},
		{"a dockerconfigjson Secret", `{"apiVersion":"v1","kind":"Secret","metadata":{"name":"pull"},"type":"kubernetes.io/dockerconfigjson","data":{".dockerconfigjson":"e30="}}`},
		{"an Ingress with no annotations", `{"apiVersion":"networking.k8s.io/v1","kind":"Ingress","metadata":{"name":"in"},"spec":{"defaultBackend":{"service":{"name":"web","port":{"number":80}}}}}`},
		{"an Ingress with unrelated annotations", `{"apiVersion":"networking.k8s.io/v1","kind":"Ingress","metadata":{"name":"in2","annotations":{"nginx.ingress.kubernetes.io/rewrite-target":"/","cert-manager.io/cluster-issuer":"letsencrypt"}},"spec":{"defaultBackend":{"service":{"name":"web","port":{"number":80}}}}}`},
		{"a ConfigMap (not matched)", `{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"cfg","annotations":{"x/server-snippet":"y"}},"data":{"k":"v"}}`},
	}
}

// ruleMessage is the message the API server should return for rule id.
func ruleMessage(t *testing.T, id string) string {
	t.Helper()
	for _, r := range byoAdmissionRules {
		if r.ID == id {
			return r.Message
		}
	}
	t.Fatalf("no rule %s", id)
	return ""
}

// TestByoAdmissionKind is the whole real-cluster proof, in the order the six questions were asked.
func TestByoAdmissionKind(t *testing.T) {
	if _, err := exec.LookPath("kubectl"); err != nil {
		t.Fatal("kubectl is not on PATH: this test needs a cluster and must not pass without one")
	}
	if ok, reason := ByoAdmissionPolicyAvailability(); !ok {
		t.Fatalf("the cluster does not serve the policy API: %s", reason)
	}

	// Unique per run, so a second run on the same cluster (the mutation step) starts clean.
	suffix := strconv.FormatInt(time.Now().UnixNano()%1_000_000_000, 36)
	enforceNS, warnNS, noModeNS := "byo-kind-enforce-"+suffix, "byo-kind-warn-"+suffix, "byo-kind-nomode-"+suffix

	policy, err := RenderByoAdmissionPolicy()
	if err != nil {
		t.Fatalf("render policy: %v", err)
	}
	mustKubectl(t, policy, "apply", "-f", "-")
	if newer, err := ByoAdmissionPolicyNewerLive(); err != nil || newer != "" {
		t.Fatalf("the just-applied policy reads as newer (%q) or unreadable (%v)", newer, err)
	}

	nsYAML, err := RenderByoNamespaces([]string{enforceNS, warnNS}, nil,
		map[string]ByoAdmissionMode{enforceNS: ByoAdmissionEnforce, warnNS: ByoAdmissionWarn})
	if err != nil {
		t.Fatalf("render namespaces: %v", err)
	}
	mustKubectl(t, nsYAML, "apply", "-f", "-")
	// managed-by but no mode: how a runner before #6446 left "default".
	mustKubectl(t, `{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"`+noModeNS+`","labels":{"alethia.io/managed-by":"byo-charts"}}}`, "apply", "-f", "-")

	// The API server compiles a policy and syncs its bindings asynchronously. Wait until a refusal by
	// a rule this test does NOT mutate (external IPs) is observed, so the mutation step cannot pass by
	// timing out here.
	sentinel := violating()[1].manifest
	deadline := time.Now().Add(2 * time.Minute)
	for {
		_, _, err := kubectlIn(sentinel, "create", "--dry-run=server", "-n", enforceNS, "-f", "-")
		if err != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the enforce binding never started refusing within 2 minutes")
		}
		time.Sleep(2 * time.Second)
	}

	t.Run("1 each rule refuses in an enforce namespace", func(t *testing.T) {
		for _, v := range violating() {
			_, errOut, err := kubectlIn(v.manifest, "create", "-n", enforceNS, "-f", "-")
			if err == nil {
				t.Errorf("%s: admitted in an enforce namespace", v.rule)
				continue
			}
			if !strings.Contains(errOut, "ValidatingAdmissionPolicy '"+ByoAdmissionEnforcePolicy+"-") || !strings.Contains(errOut, ruleMessage(t, v.rule)) {
				t.Errorf("%s: refused, but not by the policy naming the rule:\n%s", v.rule, errOut)
			}
		}
		// UPDATE is matched too: an admitted ClusterIP Service may not be changed to a LoadBalancer.
		mustKubectl(t, `{"apiVersion":"v1","kind":"Service","metadata":{"name":"upd"},"spec":{"selector":{"app":"x"},"ports":[{"port":80}]}}`, "create", "-n", enforceNS, "-f", "-")
		if _, errOut, err := kubectlIn("", "patch", "service", "upd", "-n", enforceNS, "--type=merge", "-p", `{"spec":{"type":"LoadBalancer"}}`); err == nil ||
			!strings.Contains(errOut, ByoAdmissionEnforcePolicy) {
			t.Errorf("an UPDATE to type LoadBalancer was not refused by the policy: %v\n%s", err, errOut)
		}
	})

	t.Run("2 ordinary and platform objects are admitted in an enforce namespace", func(t *testing.T) {
		for _, o := range ordinary() {
			if _, errOut, err := kubectlIn(o.manifest, "create", "-n", enforceNS, "-f", "-"); err != nil {
				t.Errorf("%s was refused: %v\n%s", o.what, err, errOut)
			} else if strings.Contains(errOut, "ValidatingAdmissionPolicy") {
				t.Errorf("%s was admitted with a policy warning:\n%s", o.what, errOut)
			}
		}
		// An UPDATE of an admitted object is admitted.
		if _, errOut, err := kubectlIn("", "label", "service", "web", "-n", enforceNS, "touched=yes"); err != nil {
			t.Errorf("an ordinary UPDATE was refused: %v\n%s", err, errOut)
		}
	})

	t.Run("3 a warn namespace admits everything, with the warning", func(t *testing.T) {
		for _, v := range violating() {
			_, errOut, err := kubectlIn(v.manifest, "create", "-n", warnNS, "-f", "-")
			if err != nil {
				t.Errorf("%s: refused in a warn namespace: %v\n%s", v.rule, err, errOut)
				continue
			}
			if !strings.Contains(errOut, "Warning:") || !strings.Contains(errOut, ByoAdmissionReportPolicy) || !strings.Contains(errOut, ruleMessage(t, v.rule)) {
				t.Errorf("%s: admitted without the report policy's warning:\n%s", v.rule, errOut)
			}
		}
		// What the runner reports for that namespace, read with its real kubectl calls.
		objs, err := ReadByoAdmissionObjects(warnNS)
		if err != nil {
			t.Fatalf("ReadByoAdmissionObjects: %v", err)
		}
		got := map[string]bool{}
		for _, v := range ByoAdmissionViolations(objs) {
			got[v.Rule] = true
		}
		for _, v := range violating() {
			if !got[v.rule] {
				t.Errorf("the runner's report of %s misses rule %s (found %v)", warnNS, v.rule, got)
			}
		}
	})

	t.Run("4 a namespace with no mode is untouched", func(t *testing.T) {
		for _, v := range violating() {
			_, errOut, err := kubectlIn(v.manifest, "create", "-n", noModeNS, "-f", "-")
			if err != nil || strings.Contains(errOut, "ValidatingAdmissionPolicy") {
				t.Errorf("%s: a namespace with no mode was reached by a binding: %v\n%s", v.rule, err, errOut)
			}
		}
	})

	t.Run("5 status.typeChecking of each policy", func(t *testing.T) {
		summary(t, "### BYO admission policy: status.typeChecking (Kubernetes %s)", serverVersion())
		for _, name := range ByoAdmissionPolicyNames() {
			var st struct {
				Metadata struct {
					Generation int64 `json:"generation"`
				} `json:"metadata"`
				Status struct {
					ObservedGeneration int64           `json:"observedGeneration"`
					TypeChecking       json.RawMessage `json:"typeChecking"`
				} `json:"status"`
			}
			deadline := time.Now().Add(time.Minute)
			for {
				raw := mustKubectl(t, "", "get", "validatingadmissionpolicy", name, "-o", "json")
				if err := json.Unmarshal([]byte(raw), &st); err != nil {
					t.Fatalf("parse %s: %v", name, err)
				}
				if st.Status.ObservedGeneration >= st.Metadata.Generation || time.Now().After(deadline) {
					break
				}
				time.Sleep(2 * time.Second)
			}
			tc := strings.TrimSpace(string(st.Status.TypeChecking))
			if tc == "" || tc == "null" {
				tc = "(not reported)"
			}
			summary(t, "- `%s` (observedGeneration %d of %d): `%s`", name, st.Status.ObservedGeneration, st.Metadata.Generation, tc)
			// Each policy matches one kind, so the type checker sees each expression only against the
			// object it reads, and must report nothing. Any warning here is what an operator would read
			// as a broken policy.
			if st.Status.ObservedGeneration < st.Metadata.Generation {
				t.Errorf("%s was not type-checked within a minute", name)
			}
			if strings.Contains(tc, "expressionWarnings") {
				t.Errorf("%s reports type-checking warnings: %s", name, tc)
			}
		}
	})

	t.Run("6 the PSA dry-run warning format the runner parses", func(t *testing.T) {
		pod := `{"apiVersion":"v1","kind":"Pod","metadata":{"name":"hostpath-agent"},"spec":{"containers":[{"name":"c","image":"registry.k8s.io/pause:3.9"}],"volumes":[{"name":"h","hostPath":{"path":"/var/log"}}]}}`
		mustKubectl(t, pod, "create", "-n", warnNS, "-f", "-")
		lines, err := PreviewByoPodSecurity(warnNS)
		if err != nil {
			t.Fatalf("PreviewByoPodSecurity: %v", err)
		}
		found := false
		for _, l := range lines {
			if strings.Contains(l, "hostpath-agent") && strings.Contains(l, "hostPath volumes") {
				found = true
			}
		}
		summary(t, "- PSA dry-run lines for `%s`: `%q`", warnNS, lines)
		if !found {
			t.Errorf("the dry run did not yield a line naming the pod and hostPath volumes: %q", lines)
		}
		// The namespace's labels were not changed by the preview.
		if got := mustKubectl(t, "", "get", "namespace", warnNS, "-o", "jsonpath={.metadata.labels.pod-security\\.kubernetes\\.io/enforce}"); got != "" {
			t.Errorf("the preview set the enforce label to %q", got)
		}
		// And enforce really refuses the same pod, with the version the label pins.
		_, errOut, err := kubectlIn(pod, "create", "-n", enforceNS, "-f", "-")
		if err == nil || !strings.Contains(errOut, `violates PodSecurity "baseline:v1.33"`) {
			t.Errorf("the enforce namespace did not refuse a hostPath pod under baseline:v1.33: %v\n%s", err, errOut)
		}
	})
}

// serverVersion is the API server's gitVersion, for the summary.
func serverVersion() string {
	out, _, err := kubectlIn("", "version", "-o", "json")
	if err != nil {
		return "unknown"
	}
	var v struct {
		ServerVersion struct {
			GitVersion string `json:"gitVersion"`
		} `json:"serverVersion"`
	}
	if json.Unmarshal([]byte(out), &v) != nil {
		return "unknown"
	}
	return v.ServerVersion.GitVersion
}
