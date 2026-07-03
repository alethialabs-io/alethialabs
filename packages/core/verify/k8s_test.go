// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"context"
	"testing"
)

const insecureManifest = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bad
  namespace: demo
spec:
  template:
    spec:
      hostNetwork: true
      volumes:
        - name: host
          hostPath:
            path: /
      containers:
        - name: app
          image: nginx:latest
          securityContext:
            privileged: true
            runAsUser: 0
`

const secureManifest = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: good
  namespace: demo
spec:
  template:
    spec:
      containers:
        - name: app
          image: reg.example.com/app:v1.2.3
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
          resources:
            limits:
              cpu: 500m
              memory: 512Mi
`

func TestEvaluateManifests_FlagsInsecure(t *testing.T) {
	rep, err := EvaluateManifests([]byte(insecureManifest))
	if err != nil {
		t.Fatal(err)
	}
	if rep.Provider != "k8s" {
		t.Errorf("provider = %q, want k8s", rep.Provider)
	}
	if rep.Verdict != StatusFail {
		t.Errorf("insecure manifest should FAIL, got %s", rep.Verdict)
	}
	if cs := controlByID(t, rep, "CONTAINERSECURITY-001"); cs.Status != StatusFail {
		t.Errorf("CONTAINERSECURITY-001 should fail (privileged + root + :latest): %+v", cs)
	}
	if ha := controlByID(t, rep, "HOSTACCESS-001"); ha.Status != StatusFail {
		t.Errorf("HOSTACCESS-001 should fail (hostNetwork + hostPath): %+v", ha)
	}
	if rl := controlByID(t, rep, "RESOURCES-001"); rl.Status != StatusWarn {
		t.Errorf("RESOURCES-001 should warn (no limits): %+v", rl)
	}
}

func TestEvaluateManifests_PassesSecure(t *testing.T) {
	rep, err := EvaluateManifests([]byte(secureManifest))
	if err != nil {
		t.Fatal(err)
	}
	if rep.Verdict != StatusPass {
		t.Errorf("secure manifest should PASS, got %s (%+v)", rep.Verdict, rep.Summary)
	}
}

func TestEvaluateManifests_RBACWildcard(t *testing.T) {
	const cr = `
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: too-broad
rules:
  - apiGroups: ["*"]
    resources: ["*"]
    verbs: ["*"]
`
	rep, err := EvaluateManifests([]byte(cr))
	if err != nil {
		t.Fatal(err)
	}
	if rbac := controlByID(t, rep, "RBAC-001"); rbac.Status != StatusFail {
		t.Errorf("RBAC-001 should fail on a wildcard ClusterRole: %+v", rbac)
	}
}

func TestEvaluateManifests_AnonymousBinding(t *testing.T) {
	const crb = `
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: anon
subjects:
  - kind: User
    name: system:anonymous
roleRef:
  kind: ClusterRole
  name: cluster-admin
`
	rep, _ := EvaluateManifests([]byte(crb))
	if rbac := controlByID(t, rep, "RBAC-001"); rbac.Status != StatusFail {
		t.Errorf("RBAC-001 should fail on an anonymous binding: %+v", rbac)
	}
}

func TestParseCustomerPlan(t *testing.T) {
	// A minimal valid plan document.
	good := `{"format_version":"1.2","resource_changes":[]}`
	if _, err := ParseCustomerPlan([]byte(good)); err != nil {
		t.Errorf("valid plan should parse: %v", err)
	}
	// Auditing a customer plan runs the same controls: a static key → KEYLESS-001 fail.
	withKey := `{"format_version":"1.2","resource_changes":[
		{"address":"aws_iam_access_key.x","type":"aws_iam_access_key","mode":"managed",
		 "change":{"actions":["create"],"after":{"user":"svc"}}}]}`
	plan, err := ParseCustomerPlan([]byte(withKey))
	if err != nil {
		t.Fatal(err)
	}
	rep, _ := Evaluate(context.Background(), plan)
	if k := controlByID(t, rep, "KEYLESS-001"); k.Status != StatusFail {
		t.Errorf("KEYLESS-001 should fail on a customer plan with a static key: %+v", k)
	}

	if _, err := ParseCustomerPlan([]byte("")); err == nil {
		t.Errorf("empty plan should error")
	}
	if _, err := ParseCustomerPlan([]byte("{\"hello\":1}")); err == nil {
		t.Errorf("non-plan JSON should error")
	}
}
