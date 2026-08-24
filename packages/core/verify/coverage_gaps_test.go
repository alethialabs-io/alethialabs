// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/netip"
	"strings"
	"testing"

	tfjson "github.com/hashicorp/terraform-json"
)

// ── AWS: the managed-policy ATTACHMENT arm of LEASTPRIV-001 ──────────────────

// TestLeastPrivilegeAttachmentARNs pins the attachment arm of LEASTPRIV-001: an
// admin-family AWS-managed ARN hard-fails, a non-admin AWS-managed ARN is an honest
// coverage gap (its body is never in the plan), a customer-managed ARN is inspected,
// and an absent / computed policy_arn is not_evaluable rather than a silent pass.
func TestLeastPrivilegeAttachmentARNs(t *testing.T) {
	tests := []struct {
		name         string
		rtype        string
		arn          string
		unknownARN   bool
		wantStatus   Status
		wantFinding  string
		wantCoverage string
	}{
		{
			name: "AdministratorAccess hard fails", rtype: "aws_iam_role_policy_attachment",
			arn: "arn:aws:iam::aws:policy/AdministratorAccess", wantStatus: StatusFail,
			wantFinding: "AdministratorAccess",
		},
		{
			name: "PowerUserAccess hard fails", rtype: "aws_iam_user_policy_attachment",
			arn: "arn:aws:iam::aws:policy/PowerUserAccess", wantStatus: StatusFail,
			wantFinding: "PowerUserAccess",
		},
		{
			name: "IAMFullAccess hard fails", rtype: "aws_iam_group_policy_attachment",
			arn: "arn:aws:iam::aws:policy/IAMFullAccess", wantStatus: StatusFail,
			wantFinding: "IAMFullAccess",
		},
		{
			name: "non-admin AWS-managed is a coverage gap", rtype: "aws_iam_policy_attachment",
			arn: "arn:aws:iam::aws:policy/ReadOnlyAccess", wantStatus: StatusNotEvaluable,
			wantCoverage: "AWS-managed policy body not in plan",
		},
		{
			name: "customer-managed by arn is inspected", rtype: "aws_iam_role_policy_attachment",
			arn: "arn:aws:iam::123456789012:policy/least-priv", wantStatus: StatusPass,
		},
		{
			name: "computed policy_arn is not_evaluable", rtype: "aws_iam_role_policy_attachment",
			unknownARN: true, wantStatus: StatusNotEvaluable,
			wantCoverage: "policy_arn not known until apply",
		},
		{
			name: "absent policy_arn is not_evaluable", rtype: "aws_iam_role_policy_attachment",
			arn: "", wantStatus: StatusNotEvaluable,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := plannedResource{
				address:      tc.rtype + ".x",
				rtype:        tc.rtype,
				after:        map[string]any{"policy_arn": tc.arn},
				afterUnknown: map[string]any{},
			}
			if tc.unknownARN {
				r.after = map[string]any{}
				r.afterUnknown = map[string]any{"policy_arn": true}
			}
			c := controlLeastPrivilege([]plannedResource{r})
			if c.Status != tc.wantStatus {
				t.Fatalf("status = %q, want %q (coverage %q, findings %+v)", c.Status, tc.wantStatus, c.Coverage, c.Findings)
			}
			if tc.wantFinding != "" {
				if len(c.Findings) != 1 || !strings.Contains(c.Findings[0].Message, tc.wantFinding) {
					t.Errorf("findings = %+v, want one mentioning %q", c.Findings, tc.wantFinding)
				}
			}
			if tc.wantCoverage != "" && !strings.Contains(c.Coverage, tc.wantCoverage) {
				t.Errorf("coverage = %q, want it to mention %q", c.Coverage, tc.wantCoverage)
			}
		})
	}
}

// TestShortARNAndAdminFamily pins the ARN helpers the attachment arm reports with.
func TestShortARNAndAdminFamily(t *testing.T) {
	tests := []struct {
		arn      string
		short    string
		isAdmin  bool
		comment  string
		multiArn bool
	}{
		{arn: "arn:aws:iam::aws:policy/AdministratorAccess", short: "AdministratorAccess", isAdmin: true},
		{arn: "arn:aws:iam::aws:policy/PowerUserAccess", short: "PowerUserAccess", isAdmin: true},
		{arn: "arn:aws:iam::aws:policy/IAMFullAccess", short: "IAMFullAccess", isAdmin: true},
		{arn: "arn:aws:iam::aws:policy/ReadOnlyAccess", short: "ReadOnlyAccess", isAdmin: false},
		{arn: "no-slash-at-all", short: "no-slash-at-all", isAdmin: false},
		{arn: "trailing/", short: "trailing/", isAdmin: false},
	}
	for _, tc := range tests {
		t.Run(tc.arn, func(t *testing.T) {
			if got := shortARN(tc.arn); got != tc.short {
				t.Errorf("shortARN(%q) = %q, want %q", tc.arn, got, tc.short)
			}
			if got := isAdminManagedPolicy(tc.arn); got != tc.isAdmin {
				t.Errorf("isAdminManagedPolicy(%q) = %v, want %v", tc.arn, got, tc.isAdmin)
			}
		})
	}
}

// ── IAM document parsing (policy.go) ─────────────────────────────────────────

// TestToStringSlice pins the permissive coercion of an IAM field that Terraform may
// serialise as a scalar, a list, or something the parser must refuse to guess at.
func TestToStringSlice(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want []string
	}{
		{name: "nil", in: nil, want: nil},
		{name: "scalar string", in: "s3:GetObject", want: []string{"s3:GetObject"}},
		{name: "json list", in: []any{"a", "b"}, want: []string{"a", "b"}},
		{name: "json list drops non-strings", in: []any{"a", 3, true}, want: []string{"a"}},
		{name: "native slice passthrough", in: []string{"a", "b"}, want: []string{"a", "b"}},
		{name: "number is refused", in: float64(7), want: nil},
		{name: "object is refused", in: map[string]any{"a": 1}, want: nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := toStringSlice(tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("toStringSlice(%v) = %v, want %v", tc.in, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("toStringSlice(%v) = %v, want %v", tc.in, got, tc.want)
				}
			}
		})
	}
}

// TestAttrUnknown pins the after_unknown reader: only an explicit true (or a nested
// structure) means "computed until apply"; anything else is a known value.
func TestAttrUnknown(t *testing.T) {
	tests := []struct {
		name         string
		afterUnknown any
		key          string
		want         bool
	}{
		{name: "not an object", afterUnknown: "nope", key: "policy", want: false},
		{name: "explicit true", afterUnknown: map[string]any{"policy": true}, key: "policy", want: true},
		{name: "explicit false", afterUnknown: map[string]any{"policy": false}, key: "policy", want: false},
		{name: "absent key", afterUnknown: map[string]any{}, key: "policy", want: false},
		{name: "nested object", afterUnknown: map[string]any{"tags": map[string]any{"a": true}}, key: "tags", want: true},
		{name: "nested list", afterUnknown: map[string]any{"ids": []any{false}}, key: "ids", want: true},
		{name: "unexpected scalar", afterUnknown: map[string]any{"policy": "maybe"}, key: "policy", want: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := attrUnknown(tc.afterUnknown, tc.key); got != tc.want {
				t.Errorf("attrUnknown = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestParseIAMPolicyShapes pins the "present / evaluable" contract: a body we cannot
// read is present-but-not-evaluable so the caller reports a coverage gap, never a pass.
func TestParseIAMPolicyShapes(t *testing.T) {
	tests := []struct {
		name          string
		after         map[string]any
		afterUnknown  any
		wantPresent   bool
		wantEvaluable bool
		wantStatement int
	}{
		{
			name: "absent attribute", after: map[string]any{}, afterUnknown: map[string]any{},
			wantPresent: false, wantEvaluable: false,
		},
		{
			name: "explicit null", after: map[string]any{"policy": nil}, afterUnknown: map[string]any{},
			wantPresent: false, wantEvaluable: false,
		},
		{
			name: "computed until apply", after: map[string]any{}, afterUnknown: map[string]any{"policy": true},
			wantPresent: true, wantEvaluable: false,
		},
		{
			name: "blank body", after: map[string]any{"policy": "   "}, afterUnknown: map[string]any{},
			wantPresent: true, wantEvaluable: false,
		},
		{
			name: "non-JSON body", after: map[string]any{"policy": "not json at all"}, afterUnknown: map[string]any{},
			wantPresent: true, wantEvaluable: false,
		},
		{
			name: "non-string non-object body", after: map[string]any{"policy": float64(3)}, afterUnknown: map[string]any{},
			wantPresent: true, wantEvaluable: false,
		},
		{
			name: "already-decoded object body",
			after: map[string]any{"policy": map[string]any{
				"Statement": map[string]any{"Effect": "Allow", "Action": "*", "Resource": "*"},
			}},
			afterUnknown: map[string]any{},
			wantPresent:  true, wantEvaluable: true, wantStatement: 1,
		},
		{
			name:         "string body with a statement array",
			after:        map[string]any{"policy": `{"Statement":[{"Effect":"Allow","Action":["s3:Get*"],"Resource":"*"},{"Effect":"Deny","Action":"*","Resource":"*"}]}`},
			afterUnknown: map[string]any{},
			wantPresent:  true, wantEvaluable: true, wantStatement: 2,
		},
		{
			name:         "statement field of an unexpected type yields no statements",
			after:        map[string]any{"policy": `{"Statement":"nonsense"}`},
			afterUnknown: map[string]any{},
			wantPresent:  true, wantEvaluable: true, wantStatement: 0,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			doc, present, evaluable := parseIAMPolicy(tc.after, tc.afterUnknown, "policy")
			if present != tc.wantPresent || evaluable != tc.wantEvaluable {
				t.Fatalf("present=%v evaluable=%v, want present=%v evaluable=%v", present, evaluable, tc.wantPresent, tc.wantEvaluable)
			}
			if !evaluable {
				return
			}
			if len(doc.Statements) != tc.wantStatement {
				t.Fatalf("statements = %d, want %d", len(doc.Statements), tc.wantStatement)
			}
		})
	}
}

// TestExtractStatementsDropsNonObjects pins that a Statement array holding junk
// elements contributes no statements rather than panicking or inventing one.
func TestExtractStatementsDropsNonObjects(t *testing.T) {
	got := extractStatements([]any{"junk", float64(1), map[string]any{"Effect": "Allow"}})
	if len(got) != 1 {
		t.Fatalf("extractStatements = %d statements, want 1", len(got))
	}
	if n := len(extractStatements(nil)); n != 0 {
		t.Errorf("extractStatements(nil) = %d, want 0", n)
	}
}

// TestAsStringNonString pins that a non-string JSON value reads as the empty string
// (the "attribute not usable" signal every control branches on).
func TestAsStringNonString(t *testing.T) {
	if got := asString(float64(3)); got != "" {
		t.Errorf("asString(3) = %q, want empty", got)
	}
	if got := asString("x"); got != "x" {
		t.Errorf("asString(\"x\") = %q, want x", got)
	}
}

// ── AWS federated-trust helpers ──────────────────────────────────────────────

// TestActionCovers pins the wildcard-aware action matcher (#2014): globs expand
// in the POLICY action only, `want` is always literal, and matching is
// case-insensitive like IAM's.
func TestActionCovers(t *testing.T) {
	tests := []struct {
		policy, want string
		covers       bool
	}{
		{"sts:AssumeRoleWithWebIdentity", "sts:AssumeRoleWithWebIdentity", true},
		{"STS:assumerolewithwebidentity", "sts:AssumeRoleWithWebIdentity", true},
		{"*", "sts:AssumeRoleWithWebIdentity", true},
		{"sts:*", "sts:AssumeRoleWithWebIdentity", true},
		{"sts:AssumeRole*", "sts:AssumeRoleWithWebIdentity", true},
		{"sts:AssumeRoleWithWebIdentit?", "sts:AssumeRoleWithWebIdentity", true},
		{"sts:*", "sts:AssumeRole", true},
		// Literal-vs-literal asymmetry: neither near-miss covers the other.
		{"sts:AssumeRole", "sts:AssumeRoleWithWebIdentity", false},
		{"sts:AssumeRoleWithWebIdentity", "sts:AssumeRole", false},
		// A wildcard in `want` is NOT expanded — want is always a literal.
		{"sts:AssumeRole", "sts:*", false},
		{"ec2:*", "sts:AssumeRoleWithWebIdentity", false},
		{"sts:Get*", "sts:AssumeRoleWithWebIdentity", false},
	}
	for _, tc := range tests {
		if got := actionCovers(tc.policy, tc.want); got != tc.covers {
			t.Errorf("actionCovers(%q, %q) = %v, want %v", tc.policy, tc.want, got, tc.covers)
		}
	}
}

// TestIsFederatedWebIdentity pins which trust statements OIDC-001 considers in scope.
func TestIsFederatedWebIdentity(t *testing.T) {
	fed := map[string]any{"Federated": "arn:aws:iam::1:oidc-provider/x"}
	tests := []struct {
		name string
		st   iamStatement
		want bool
	}{
		{name: "deny is out of scope", st: iamStatement{Effect: "Deny", Principal: fed, Action: []string{"sts:AssumeRoleWithWebIdentity"}}},
		{name: "no principal", st: iamStatement{Effect: "Allow", Action: []string{"sts:AssumeRoleWithWebIdentity"}}},
		{name: "service principal", st: iamStatement{Effect: "Allow", Principal: map[string]any{"Service": "ec2.amazonaws.com"}, Action: []string{"sts:AssumeRoleWithWebIdentity"}}},
		{name: "federated but wrong action", st: iamStatement{Effect: "Allow", Principal: fed, Action: []string{"sts:AssumeRole"}}},
		{name: "federated web identity", st: iamStatement{Effect: "Allow", Principal: fed, Action: []string{"sts:AssumeRoleWithWebIdentity"}}, want: true},
		{name: "case insensitive", st: iamStatement{Effect: "allow", Principal: fed, Action: []string{"STS:AssumeRoleWithWebIdentity"}}, want: true},
		// #2014: wildcard grants are strictly MORE permissive than the literal
		// spelling — they must stay in scope, never fall out of it.
		{name: "sts service wildcard", st: iamStatement{Effect: "Allow", Principal: fed, Action: []string{"sts:*"}}, want: true},
		{name: "full wildcard", st: iamStatement{Effect: "Allow", Principal: fed, Action: []string{"*"}}, want: true},
		{name: "prefix glob", st: iamStatement{Effect: "Allow", Principal: fed, Action: []string{"sts:AssumeRole*"}}, want: true},
		{name: "other-service wildcard", st: iamStatement{Effect: "Allow", Principal: fed, Action: []string{"ec2:*"}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := isFederatedWebIdentity(tc.st); got != tc.want {
				t.Errorf("isFederatedWebIdentity = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestSubjectIsBound pins the :sub binding judgement, including the non-map and
// non-:sub condition entries the loop must skip.
func TestSubjectIsBound(t *testing.T) {
	tests := []struct {
		name    string
		cond    map[string]any
		wantOK  bool
		wantWhy string
	}{
		{name: "no condition at all", wantWhy: "no `:sub` condition"},
		{
			name:    "condition value is not an object",
			cond:    map[string]any{"StringEquals": "nonsense"},
			wantWhy: "no `:sub` condition",
		},
		{
			name:    "only an aud condition",
			cond:    map[string]any{"StringEquals": map[string]any{"x:aud": "sts.amazonaws.com"}},
			wantWhy: "no `:sub` condition",
		},
		{
			name:    "wildcard StringLike sub",
			cond:    map[string]any{"StringLike": map[string]any{"x:sub": "repo:acme/*:*"}},
			wantWhy: "wildcard",
		},
		{
			name:    "wildcard in a list of subs",
			cond:    map[string]any{"StringLike": map[string]any{"x:sub": []any{"repo:acme/app:ref:refs/heads/main", "repo:*"}}},
			wantWhy: "wildcard",
		},
		{
			name:   "pinned StringEquals sub",
			cond:   map[string]any{"StringEquals": map[string]any{"x:sub": "repo:acme/app:ref:refs/heads/main"}},
			wantOK: true,
		},
		{
			name:   "StringLike without a wildcard is accepted",
			cond:   map[string]any{"StringLike": map[string]any{"x:sub": "repo:acme/app:ref:refs/heads/main"}},
			wantOK: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ok, why := subjectIsBound(iamStatement{Condition: tc.cond})
			if ok != tc.wantOK {
				t.Fatalf("subjectIsBound ok = %v (%q), want %v", ok, why, tc.wantOK)
			}
			if tc.wantWhy != "" && !strings.Contains(why, tc.wantWhy) {
				t.Errorf("reason = %q, want it to mention %q", why, tc.wantWhy)
			}
		})
	}
}

// ── plan configuration index (module walk + expression reads) ────────────────

// configuredPlan is a plan whose configuration section spans the root module and a
// nested module call — the shape configExprIndex must walk to resolve references.
const configuredPlan = `{
  "format_version": "1.2",
  "resource_changes": [
    {"address":"module.net.hcloud_server.node","mode":"managed","type":"hcloud_server","name":"node",
     "change":{"actions":["create"],"after":{"name":"node"},"after_unknown":{"firewall_ids":true}}},
    {"address":"hcloud_server.literal","mode":"managed","type":"hcloud_server","name":"literal",
     "change":{"actions":["create"],"after":{"name":"literal"},"after_unknown":{"firewall_ids":true}}}
  ],
  "configuration": {
    "root_module": {
      "resources": [
        {"address":"hcloud_server.literal","mode":"managed","type":"hcloud_server","name":"literal",
         "expressions":{"firewall_ids":{"constant_value":[42]}}}
      ],
      "module_calls": {
        "net": {
          "module": {
            "resources": [
              {"address":"hcloud_server.node","mode":"managed","type":"hcloud_server","name":"node",
               "expressions":{"firewall_ids":{"references":["hcloud_firewall.this.id","hcloud_firewall.this"]}}}
            ]
          }
        }
      }
    }
  }
}`

// TestConfigExprIndexWalksModules pins that configuration references resolve through a
// module call with the module prefix attached, and that a literal constant is readable.
func TestConfigExprIndexWalksModules(t *testing.T) {
	plan := mustPlan(t, configuredPlan)
	planned := gatherPlanned(plan)
	if len(planned) != 2 {
		t.Fatalf("planned = %d, want 2", len(planned))
	}
	byAddr := map[string]plannedResource{}
	for _, p := range planned {
		byAddr[p.address] = p
	}

	inModule := byAddr["module.net.hcloud_server.node"]
	if !inModule.hasConfig() {
		t.Fatal("module resource lost its configuration")
	}
	refs := inModule.exprRefs("firewall_ids")
	if len(refs) != 2 || refs[0] != "module.net.hcloud_firewall.this.id" {
		t.Fatalf("exprRefs = %v, want module-prefixed refs", refs)
	}
	// A reference-sourced expression never yields a usable literal list.
	if konst, ok := inModule.exprConstant("firewall_ids"); ok {
		if _, isList := konst.([]any); isList {
			t.Errorf("a reference expression reported a literal list %#v", konst)
		}
	}

	root := byAddr["hcloud_server.literal"]
	konst, ok := root.exprConstant("firewall_ids")
	if !ok {
		t.Fatal("literal firewall_ids not readable as a constant")
	}
	if lst, isList := konst.([]any); !isList || len(lst) != 1 {
		t.Fatalf("constant = %#v, want a one-element list", konst)
	}
	if refs := root.exprRefs("nonexistent"); refs != nil {
		t.Errorf("exprRefs of an unset attribute = %v, want nil", refs)
	}

	// Both servers are protected: one by reference, one by a non-empty literal.
	c := controlHCloudServerFirewall(planned)
	if c.Status != StatusPass {
		t.Errorf("HCLOUD-FW-001 = %q (coverage %q), want pass", c.Status, c.Coverage)
	}
}

// TestPlannedResourceWithoutConfiguration pins the no-configuration accessors: a plan
// with no `configuration` section resolves no references and no constants.
func TestPlannedResourceWithoutConfiguration(t *testing.T) {
	r := plannedResource{address: "hcloud_server.a", rtype: "hcloud_server"}
	if r.hasConfig() {
		t.Error("hasConfig must be false with no configuration")
	}
	if refs := r.exprRefs("firewall_ids"); refs != nil {
		t.Errorf("exprRefs = %v, want nil", refs)
	}
	if _, ok := r.exprConstant("firewall_ids"); ok {
		t.Error("exprConstant must report absent with no configuration")
	}
	if got := configExprIndex(&tfjson.Plan{}); got != nil {
		t.Errorf("configExprIndex of a config-less plan = %v, want nil", got)
	}
}

// The address normaliser these configuration lookups depend on now lives in
// packages/core/tfaddr, and its table is TestConfigAddress there — including the
// module-nested rows this table never had, which is why #2361 stayed invisible here.

// ── Hetzner posture helpers ─────────────────────────────────────────────────

// TestPortRuleCovers pins the hcloud `port` field reader, including ranges, the
// all-ports sentinel, and malformed ranges (which must not claim coverage).
func TestPortRuleCovers(t *testing.T) {
	tests := []struct {
		port   string
		target int
		want   bool
	}{
		{port: "22", target: 22, want: true},
		{port: "22", target: 6443},
		{port: " 22 ", target: 22, want: true},
		{port: "", target: 22, want: true},
		{port: "any", target: 50001, want: true},
		{port: "ANY", target: 1, want: true},
		{port: "50000-50001", target: 50000, want: true},
		{port: "50000-50001", target: 50001, want: true},
		{port: "50000-50001", target: 49999},
		{port: "1-65535", target: 22, want: true},
		{port: "abc-def", target: 22},
		{port: "20-", target: 22},
		{port: "notaport", target: 22},
		{port: "-22", target: 22},
	}
	for _, tc := range tests {
		t.Run(tc.port+"/"+portLabel(tc.port), func(t *testing.T) {
			if got := portRuleCovers(tc.port, tc.target); got != tc.want {
				t.Errorf("portRuleCovers(%q, %d) = %v, want %v", tc.port, tc.target, got, tc.want)
			}
		})
	}
}

// TestPortAndProtoLabels pins the finding-message renderers, including the portless
// protocols that must not be described with a port.
func TestPortAndProtoLabels(t *testing.T) {
	if got := portLabel(" "); got != "any (all ports)" {
		t.Errorf("portLabel(blank) = %q", got)
	}
	if got := portLabel("6443"); got != "6443" {
		t.Errorf("portLabel(6443) = %q", got)
	}
	tests := []struct {
		proto, port, want string
	}{
		{proto: "icmp", port: "", want: "icmp"},
		{proto: "esp", port: "", want: "esp"},
		{proto: "gre", port: "", want: "gre"},
		{proto: "", port: "22", want: "port 22"},
		{proto: "udp", port: "53", want: "udp port 53"},
		{proto: "tcp", port: "any", want: "tcp port any (all ports)"},
	}
	for _, tc := range tests {
		t.Run(tc.proto+"/"+tc.port, func(t *testing.T) {
			if got := protoPortLabel(tc.proto, tc.port); got != tc.want {
				t.Errorf("protoPortLabel(%q,%q) = %q, want %q", tc.proto, tc.port, got, tc.want)
			}
		})
	}
}

// TestHasVeryBroadSource pins the stated WARN backstop for SSH sources that are not
// provably world-open by union but are far too broad to pass silently.
func TestHasVeryBroadSource(t *testing.T) {
	tests := []struct {
		name    string
		sources []string
		want    bool
	}{
		{name: "empty"},
		{name: "unparseable is ignored", sources: []string{"not-a-cidr", "10.0.0.1"}},
		{name: "v4 slash 8", sources: []string{"10.0.0.0/8"}, want: true},
		{name: "v4 slash 7", sources: []string{"10.0.0.0/7"}, want: true},
		{name: "v4 slash 16 is not broad", sources: []string{"10.0.0.0/16"}},
		{name: "v6 slash 16", sources: []string{"2000::/16"}, want: true},
		{name: "v6 slash 48 is not broad", sources: []string{"2001:db8::/48"}},
		{name: "mixed, one broad", sources: []string{"192.168.0.0/24", "11.0.0.0/8"}, want: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := hasVeryBroadSource(tc.sources); got != tc.want {
				t.Errorf("hasVeryBroadSource(%v) = %v, want %v", tc.sources, got, tc.want)
			}
		})
	}
}

// TestPrefixLastAndUnionCoverage pins the sweep-line union used to detect a
// split-CIDR spelling of "the whole internet".
func TestPrefixLastAndUnionCoverage(t *testing.T) {
	if got := prefixLast(netip.MustParsePrefix("10.0.0.0/8")).String(); got != "10.255.255.255" {
		t.Errorf("prefixLast(10.0.0.0/8) = %s", got)
	}
	if got := prefixLast(netip.MustParsePrefix("2001:db8::/32")).String(); got != "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff" {
		t.Errorf("prefixLast(2001:db8::/32) = %s", got)
	}

	tests := []struct {
		name     string
		prefixes []string
		want     bool
	}{
		{name: "empty is not coverage"},
		{name: "quarters cover", prefixes: []string{"0.0.0.0/2", "64.0.0.0/2", "128.0.0.0/2", "192.0.0.0/2"}, want: true},
		{name: "out of order still covers", prefixes: []string{"128.0.0.0/1", "0.0.0.0/1"}, want: true},
		{name: "overlapping covers", prefixes: []string{"0.0.0.0/1", "0.0.0.0/2", "128.0.0.0/1"}, want: true},
		{name: "gap in the middle", prefixes: []string{"0.0.0.0/2", "128.0.0.0/1"}},
		{name: "does not start at zero", prefixes: []string{"64.0.0.0/2", "128.0.0.0/1"}},
		{name: "top half missing", prefixes: []string{"0.0.0.0/1"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ps := make([]netip.Prefix, 0, len(tc.prefixes))
			for _, s := range tc.prefixes {
				ps = append(ps, netip.MustParsePrefix(s))
			}
			if got := unionCoversAll(ps, netip.AddrFrom4([4]byte{})); got != tc.want {
				t.Errorf("unionCoversAll(%v) = %v, want %v", tc.prefixes, got, tc.want)
			}
		})
	}
}

// TestRuleUnknownShapes pins the after_unknown reader for firewall rule blocks: an
// all-false collection is KNOWN, only a true leaf is computed-until-apply.
func TestRuleUnknownShapes(t *testing.T) {
	tests := []struct {
		name         string
		afterUnknown any
		index        int
		want         bool
	}{
		{name: "after_unknown is not an object", afterUnknown: true},
		{name: "no rule key", afterUnknown: map[string]any{}},
		{name: "index past the end", afterUnknown: map[string]any{"rule": []any{}}, index: 3},
		{name: "bare true element", afterUnknown: map[string]any{"rule": []any{true}}, want: true},
		{name: "bare false element", afterUnknown: map[string]any{"rule": []any{false}}},
		{name: "unexpected element type", afterUnknown: map[string]any{"rule": []any{"x"}}},
		{
			name:         "all-false leaves are known",
			afterUnknown: map[string]any{"rule": []any{map[string]any{"destination_ips": []any{}, "source_ips": []any{false, false}, "port": false}}},
		},
		{
			name:         "computed port",
			afterUnknown: map[string]any{"rule": []any{map[string]any{"port": true}}},
			want:         true,
		},
		{
			name:         "computed source ip leaf",
			afterUnknown: map[string]any{"rule": []any{map[string]any{"source_ips": []any{false, true}}}},
			want:         true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ruleUnknown(tc.afterUnknown, tc.index); got != tc.want {
				t.Errorf("ruleUnknown = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestAnyUnknownLeaf pins the recursive after_unknown leaf scan.
func TestAnyUnknownLeaf(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want bool
	}{
		{name: "nil"},
		{name: "false", in: false},
		{name: "true", in: true, want: true},
		{name: "string is known", in: "x"},
		{name: "nested map with a true", in: map[string]any{"a": map[string]any{"b": true}}, want: true},
		{name: "nested list all false", in: []any{[]any{false, false}, false}},
		{name: "nested list with a true", in: []any{[]any{false, true}}, want: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := anyUnknownLeaf(tc.in); got != tc.want {
				t.Errorf("anyUnknownLeaf(%#v) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

// TestRuleListWhollyUnknown pins the "whole rule block list computed" detector.
func TestRuleListWhollyUnknown(t *testing.T) {
	if ruleListWhollyUnknown("not an object") {
		t.Error("a non-object after_unknown must not read as wholly unknown")
	}
	if ruleListWhollyUnknown(map[string]any{"rule": []any{map[string]any{}}}) {
		t.Error("a rule LIST is a known block list, not a wholly unknown one")
	}
	if !ruleListWhollyUnknown(map[string]any{"rule": true}) {
		t.Error("a bare true rule attribute is wholly unknown")
	}
}

// TestRefsInclude pins the reference matcher used to map an attachment to a server.
func TestRefsInclude(t *testing.T) {
	refs := []string{"hcloud_server.node.id", "hcloud_firewall.this"}
	tests := []struct {
		base string
		want bool
	}{
		{base: "hcloud_server.node", want: true},
		{base: "hcloud_firewall.this", want: true},
		{base: "hcloud_server.other"},
		{base: "hcloud_server.no", want: false},
	}
	for _, tc := range tests {
		t.Run(tc.base, func(t *testing.T) {
			if got := refsInclude(refs, tc.base); got != tc.want {
				t.Errorf("refsInclude(%v, %q) = %v, want %v", refs, tc.base, got, tc.want)
			}
		})
	}
}

// TestJudgeServerFirewallKnownValues pins the branches of the per-server firewall
// judgement that read the plan VALUES rather than the configuration.
func TestJudgeServerFirewallKnownValues(t *testing.T) {
	tests := []struct {
		name        string
		after       map[string]any
		unknown     any
		attachments []fwAttachment
		applyTo     bool
		want        fwVerdict
	}{
		{
			name:  "known non-empty firewall_ids is protected",
			after: map[string]any{"firewall_ids": []any{float64(1)}},
			want:  fwProtected,
		},
		{
			name:  "known empty firewall_ids with nothing external is a hard fail",
			after: map[string]any{"firewall_ids": []any{}},
			want:  fwUnprotected,
		},
		{
			name:        "known empty firewall_ids saved by an attachment",
			after:       map[string]any{"firewall_ids": []any{}},
			attachments: []fwAttachment{{address: "hcloud_firewall_attachment.a", serverRefs: []string{"hcloud_server.node.id"}, refsVisible: true}},
			want:        fwProtected,
		},
		{
			name:        "label-selector attachment is unmappable",
			after:       map[string]any{"firewall_ids": []any{}},
			attachments: []fwAttachment{{address: "hcloud_firewall_attachment.a", usesLabels: true, refsVisible: true}},
			want:        fwNotEvaluable,
		},
		{
			name:        "attachment with invisible refs is unmappable",
			after:       map[string]any{"firewall_ids": []any{}},
			attachments: []fwAttachment{{address: "hcloud_firewall_attachment.a"}},
			want:        fwNotEvaluable,
		},
		{
			name:    "apply_to selector present is not_evaluable, never a false brick",
			after:   map[string]any{"firewall_ids": []any{}},
			applyTo: true,
			want:    fwNotEvaluable,
		},
		{
			name:    "computed firewall_ids with no configuration is not_evaluable",
			after:   map[string]any{},
			unknown: map[string]any{"firewall_ids": true},
			want:    fwNotEvaluable,
		},
		{
			name:    "no value, not unknown, no configuration is a hard fail",
			after:   map[string]any{},
			unknown: map[string]any{},
			want:    fwUnprotected,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := plannedResource{address: "hcloud_server.node", rtype: "hcloud_server", after: tc.after, afterUnknown: tc.unknown}
			got, _ := judgeServerFirewall(&r, tc.attachments, tc.applyTo)
			if got != tc.want {
				t.Errorf("judgeServerFirewall = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestJudgeServerFirewallFromConfiguration pins the configuration-driven branches:
// a literal empty list is "configured to no firewall"; an unresolvable expression is
// an honest not_evaluable rather than a guess in either direction.
func TestJudgeServerFirewallFromConfiguration(t *testing.T) {
	emptyLiteral := plannedResource{
		address: "hcloud_server.node", rtype: "hcloud_server",
		after: map[string]any{}, afterUnknown: map[string]any{"firewall_ids": true},
		hasCfg: true,
		configExprs: map[string]*tfjson.Expression{
			"firewall_ids": {ExpressionData: &tfjson.ExpressionData{ConstantValue: []any{}}},
		},
	}
	if got, _ := judgeServerFirewall(&emptyLiteral, nil, false); got != fwUnprotected {
		t.Errorf("literal empty firewall_ids = %v, want fwUnprotected", got)
	}

	fromVar := plannedResource{
		address: "hcloud_server.node", rtype: "hcloud_server",
		after: map[string]any{}, afterUnknown: map[string]any{"firewall_ids": true},
		hasCfg: true,
		configExprs: map[string]*tfjson.Expression{
			"firewall_ids": {ExpressionData: &tfjson.ExpressionData{References: []string{"var.firewall_ids"}}},
		},
	}
	got, note := judgeServerFirewall(&fromVar, nil, false)
	if got != fwNotEvaluable {
		t.Errorf("var-sourced firewall_ids = %v, want fwNotEvaluable", got)
	}
	if !strings.Contains(note, "var.firewall_ids") {
		t.Errorf("note = %q, want it to name the unresolvable expression", note)
	}

	noAttr := plannedResource{
		address: "hcloud_server.node", rtype: "hcloud_server",
		after: map[string]any{}, afterUnknown: map[string]any{"firewall_ids": true},
		hasCfg: true, configExprs: map[string]*tfjson.Expression{},
	}
	if got, _ := judgeServerFirewall(&noAttr, nil, false); got != fwUnprotected {
		t.Errorf("configuration present but firewall_ids unset = %v, want fwUnprotected", got)
	}
}

// TestAnyFirewallHasApplyTo pins the apply_to detector that keeps a label-based BYO
// firewall from producing a false hard fail.
func TestAnyFirewallHasApplyTo(t *testing.T) {
	none := []plannedResource{{rtype: "hcloud_firewall", after: map[string]any{}}}
	if anyFirewallHasApplyTo(none) {
		t.Error("no apply_to must report false")
	}
	empty := []plannedResource{{rtype: "hcloud_firewall", after: map[string]any{"apply_to": []any{}}}}
	if anyFirewallHasApplyTo(empty) {
		t.Error("an empty apply_to list must report false")
	}
	set := []plannedResource{
		{rtype: "hcloud_server", after: map[string]any{"apply_to": []any{map[string]any{"label_selector": "role=worker"}}}},
		{rtype: "hcloud_firewall", after: map[string]any{"apply_to": []any{map[string]any{"label_selector": "role=worker"}}}},
	}
	if !anyFirewallHasApplyTo(set) {
		t.Error("a firewall with apply_to must report true")
	}
}

// TestCollectFirewallAttachmentsShapes pins how an attachment's coverage is read from
// values (label_selectors) and from configuration (server_ids references).
func TestCollectFirewallAttachmentsShapes(t *testing.T) {
	planned := []plannedResource{
		{address: "hcloud_firewall_attachment.byvalue", rtype: "hcloud_firewall_attachment",
			after: map[string]any{"label_selectors": []any{"role=worker"}}},
		{address: "hcloud_firewall_attachment.byconfig", rtype: "hcloud_firewall_attachment",
			after: map[string]any{}, hasCfg: true,
			configExprs: map[string]*tfjson.Expression{
				"server_ids": {ExpressionData: &tfjson.ExpressionData{References: []string{"hcloud_server.node.id"}}},
			}},
		{address: "hcloud_firewall_attachment.labelexpr", rtype: "hcloud_firewall_attachment",
			after: map[string]any{}, hasCfg: true,
			configExprs: map[string]*tfjson.Expression{
				"label_selectors": {ExpressionData: &tfjson.ExpressionData{ConstantValue: []any{"role=worker"}}},
			}},
		{address: "hcloud_server.node", rtype: "hcloud_server", after: map[string]any{}},
	}
	got := collectFirewallAttachments(planned)
	if len(got) != 3 {
		t.Fatalf("collected %d attachments, want 3", len(got))
	}
	if !got[0].usesLabels || got[0].refsVisible {
		t.Errorf("value-side label_selectors: %+v", got[0])
	}
	if got[1].usesLabels || !got[1].refsVisible || len(got[1].serverRefs) != 1 {
		t.Errorf("config-side server_ids: %+v", got[1])
	}
	if !got[2].usesLabels {
		t.Errorf("config-side label_selectors: %+v", got[2])
	}
}

// ── Alibaba RAM helpers ─────────────────────────────────────────────────────

// TestParseALIDocumentFallback pins the provider-version fallback: the writable
// attribute wins, and the older `document` spelling is still read when it is absent.
func TestParseALIDocumentFallback(t *testing.T) {
	trustDoc := `{"Version":"1","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole","Principal":{"Federated":"acs:ram::1:oidc-provider/ack"},"Condition":{"StringEquals":{"oidc:sub":"system:serviceaccount:app:sa"}}}]}`

	writable := plannedResource{
		after:        map[string]any{"assume_role_policy_document": trustDoc, "document": nil},
		afterUnknown: map[string]any{"document": true},
	}
	doc, present, ok := parseALITrust(writable)
	if !present || !ok {
		t.Fatalf("writable trust attr: present=%v evaluable=%v (the computed mirror must not win)", present, ok)
	}
	if len(doc.Statements) != 1 {
		t.Fatalf("statements = %d, want 1", len(doc.Statements))
	}

	legacy := plannedResource{after: map[string]any{"document": trustDoc}, afterUnknown: map[string]any{}}
	if _, present, ok := parseALITrust(legacy); !present || !ok {
		t.Fatalf("legacy `document` trust attr: present=%v evaluable=%v", present, ok)
	}

	policyLegacy := plannedResource{
		after:        map[string]any{"document": `{"Version":"1","Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}`},
		afterUnknown: map[string]any{},
	}
	pdoc, present, ok := parseALIPolicy(policyLegacy)
	if !present || !ok {
		t.Fatalf("legacy `document` policy attr: present=%v evaluable=%v", present, ok)
	}
	if _, failed, _ := inspectALIPolicyDoc("alicloud_ram_policy.x", pdoc); failed != 1 {
		t.Errorf("admin RAM policy failed count = %d, want 1", failed)
	}

	writablePolicy := plannedResource{
		after:        map[string]any{"policy_document": `{"Version":"1","Statement":[]}`, "document": nil},
		afterUnknown: map[string]any{"document": true},
	}
	if _, present, ok := parseALIPolicy(writablePolicy); !present || !ok {
		t.Fatalf("writable policy attr: present=%v evaluable=%v", present, ok)
	}
}

// TestIsALIFederatedTrust pins which RAM trust statements ALI-OIDC-001 covers.
func TestIsALIFederatedTrust(t *testing.T) {
	fed := map[string]any{"Federated": "acs:ram::1:oidc-provider/ack"}
	tests := []struct {
		name string
		st   iamStatement
		want bool
	}{
		{name: "deny", st: iamStatement{Effect: "Deny", Principal: fed, Action: []string{"sts:AssumeRole"}}},
		{name: "no principal", st: iamStatement{Effect: "Allow", Action: []string{"sts:AssumeRole"}}},
		{name: "service principal", st: iamStatement{Effect: "Allow", Principal: map[string]any{"Service": "ecs.aliyuncs.com"}, Action: []string{"sts:AssumeRole"}}},
		{name: "wrong action", st: iamStatement{Effect: "Allow", Principal: fed, Action: []string{"sts:AssumeRoleWithWebIdentity"}}},
		{name: "rrsa trust", st: iamStatement{Effect: "Allow", Principal: fed, Action: []string{"sts:AssumeRole"}}, want: true},
		// #2014 twin: wildcard grants cover sts:AssumeRole and must stay in scope.
		{name: "sts service wildcard", st: iamStatement{Effect: "Allow", Principal: fed, Action: []string{"sts:*"}}, want: true},
		{name: "full wildcard", st: iamStatement{Effect: "Allow", Principal: fed, Action: []string{"*"}}, want: true},
		{name: "other-service wildcard", st: iamStatement{Effect: "Allow", Principal: fed, Action: []string{"ram:*"}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := isALIFederatedTrust(tc.st); got != tc.want {
				t.Errorf("isALIFederatedTrust = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestALIPolicyHelpers pins the admin-family membership and the service-wildcard scan.
func TestALIPolicyHelpers(t *testing.T) {
	adminTests := map[string]bool{
		"AdministratorAccess":       true,
		"administratoraccess":       true,
		"AliyunRAMFullAccess":       true,
		"AliyunSTSAssumeRoleAccess": false,
		"AliyunECSFullAccess":       false,
	}
	for name, want := range adminTests {
		if got := isALIAdminSystemPolicy(name); got != want {
			t.Errorf("isALIAdminSystemPolicy(%q) = %v, want %v", name, got, want)
		}
	}

	got := serviceWildcardActions([]string{"*", "ecs:*", "oss:GetObject", "ram:*"})
	if len(got) != 2 || got[0] != "ecs:*" || got[1] != "ram:*" {
		t.Errorf("serviceWildcardActions = %v, want [ecs:* ram:*] (the bare * is a hard fail elsewhere)", got)
	}
}

// TestALILeastPrivilegeAttachmentNotEvaluable pins the attachment arm's honesty
// branches: an unknown or absent policy_type/name is never a silent pass, and a
// Custom attachment is inspected.
func TestALILeastPrivilegeAttachmentNotEvaluable(t *testing.T) {
	tests := []struct {
		name       string
		after      map[string]any
		unknown    any
		wantStatus Status
	}{
		{
			name: "computed policy_type", after: map[string]any{},
			unknown: map[string]any{"policy_type": true}, wantStatus: StatusNotEvaluable,
		},
		{
			name: "computed policy_name", after: map[string]any{},
			unknown: map[string]any{"policy_name": true}, wantStatus: StatusNotEvaluable,
		},
		{
			name: "blank fields", after: map[string]any{"policy_type": "", "policy_name": ""},
			unknown: map[string]any{}, wantStatus: StatusNotEvaluable,
		},
		{
			name:    "custom attachment is inspected",
			after:   map[string]any{"policy_type": "Custom", "policy_name": "least-priv"},
			unknown: map[string]any{}, wantStatus: StatusPass,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := controlALILeastPrivilege([]plannedResource{{
				address:      "alicloud_ram_role_policy_attachment.x",
				rtype:        "alicloud_ram_role_policy_attachment",
				after:        tc.after,
				afterUnknown: tc.unknown,
			}})
			if c.Status != tc.wantStatus {
				t.Errorf("status = %q (coverage %q), want %q", c.Status, c.Coverage, tc.wantStatus)
			}
		})
	}
}

// TestALITrustAndPolicyNotEvaluable pins that a computed RAM trust document or policy
// body demotes its control to not_evaluable rather than passing it.
func TestALITrustAndPolicyNotEvaluable(t *testing.T) {
	trust := controlALIFederatedTrust([]plannedResource{{
		address: "alicloud_ram_role.r", rtype: "alicloud_ram_role",
		after: map[string]any{}, afterUnknown: map[string]any{"assume_role_policy_document": true},
	}})
	if trust.Status != StatusNotEvaluable {
		t.Errorf("ALI-OIDC-001 with a computed trust doc = %q, want not_evaluable", trust.Status)
	}

	policy := controlALILeastPrivilege([]plannedResource{{
		address: "alicloud_ram_policy.p", rtype: "alicloud_ram_policy",
		after: map[string]any{}, afterUnknown: map[string]any{"policy_document": true, "document": true},
	}})
	if policy.Status != StatusNotEvaluable {
		t.Errorf("ALI-LEASTPRIV-001 with a computed body = %q, want not_evaluable", policy.Status)
	}

	absent := controlALILeastPrivilege([]plannedResource{{
		address: "alicloud_ram_policy.p", rtype: "alicloud_ram_policy",
		after: map[string]any{}, afterUnknown: map[string]any{},
	}})
	if absent.Status != StatusNotEvaluable {
		t.Errorf("ALI-LEASTPRIV-001 with no body at all = %q, want not_evaluable", absent.Status)
	}
}

// ── Azure / GCP honesty branches ────────────────────────────────────────────

// TestAzureLeastPrivilegeNotEvaluable pins the two blind spots of AZURE-LEASTPRIV-001:
// a computed role name, and an assignment made by role_definition_id.
func TestAzureLeastPrivilegeNotEvaluable(t *testing.T) {
	tests := []struct {
		name         string
		after        map[string]any
		unknown      any
		wantStatus   Status
		wantCoverage string
	}{
		{
			name: "computed role name", after: map[string]any{},
			unknown: map[string]any{"role_definition_name": true}, wantStatus: StatusNotEvaluable,
			wantCoverage: "role_definition_name not known until apply",
		},
		{
			name:    "assigned by definition id",
			after:   map[string]any{"role_definition_id": "/subscriptions/s/providers/Microsoft.Authorization/roleDefinitions/guid"},
			unknown: map[string]any{}, wantStatus: StatusNotEvaluable,
			wantCoverage: "assigned by role_definition_id",
		},
		{
			name:    "reader is neither owner nor contributor",
			after:   map[string]any{"role_definition_name": "Reader", "scope": "/subscriptions/s/resourceGroups/rg"},
			unknown: map[string]any{}, wantStatus: StatusPass,
		},
		{
			name:    "contributor warns",
			after:   map[string]any{"role_definition_name": "Contributor", "scope": "/subscriptions/s"},
			unknown: map[string]any{}, wantStatus: StatusWarn,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := controlAzureLeastPrivilege([]plannedResource{{
				address: "azurerm_role_assignment.x", rtype: "azurerm_role_assignment",
				after: tc.after, afterUnknown: tc.unknown,
			}})
			if c.Status != tc.wantStatus {
				t.Fatalf("status = %q (coverage %q), want %q", c.Status, c.Coverage, tc.wantStatus)
			}
			if tc.wantCoverage != "" && !strings.Contains(c.Coverage, tc.wantCoverage) {
				t.Errorf("coverage = %q, want it to mention %q", c.Coverage, tc.wantCoverage)
			}
		})
	}
}

// TestScopeSuffix pins the blast-radius annotation attached to a role-assignment finding.
func TestScopeSuffix(t *testing.T) {
	tests := []struct {
		scope, want string
	}{
		{scope: "/providers/Microsoft.Management/managementGroups/root", want: " at management-group scope (very broad)"},
		{scope: "/subscriptions/0000", want: " at subscription scope (broad)"},
		{scope: "/subscriptions/0000/resourceGroups/rg", want: ""},
		{scope: "", want: ""},
	}
	for _, tc := range tests {
		t.Run(tc.scope, func(t *testing.T) {
			if got := scopeSuffix(tc.scope); got != tc.want {
				t.Errorf("scopeSuffix(%q) = %q, want %q", tc.scope, got, tc.want)
			}
		})
	}
}

// TestAzureFederatedSubjectBranches pins AZURE-FED-001 across a computed, blank,
// wildcard and pinned subject.
func TestAzureFederatedSubjectBranches(t *testing.T) {
	tests := []struct {
		name       string
		after      map[string]any
		unknown    any
		wantStatus Status
	}{
		{name: "computed subject", after: map[string]any{}, unknown: map[string]any{"subject": true}, wantStatus: StatusNotEvaluable},
		{name: "blank subject", after: map[string]any{"subject": "  "}, unknown: map[string]any{}, wantStatus: StatusFail},
		{name: "wildcard subject", after: map[string]any{"subject": "repo:acme/*"}, unknown: map[string]any{}, wantStatus: StatusFail},
		{name: "pinned subject", after: map[string]any{"subject": "repo:acme/app:ref:refs/heads/main"}, unknown: map[string]any{}, wantStatus: StatusPass},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := controlAzureFederatedSubject([]plannedResource{{
				address: "azuread_application_federated_identity_credential.x",
				rtype:   "azuread_application_federated_identity_credential",
				after:   tc.after, afterUnknown: tc.unknown,
			}})
			if c.Status != tc.wantStatus {
				t.Errorf("status = %q (coverage %q), want %q", c.Status, c.Coverage, tc.wantStatus)
			}
		})
	}
}

// TestGCPNotEvaluableBranches pins the computed-attribute blind spots on the GCP set.
func TestGCPNotEvaluableBranches(t *testing.T) {
	wif := controlGCPWorkloadIdentity([]plannedResource{{
		address: "google_iam_workload_identity_pool_provider.p",
		rtype:   "google_iam_workload_identity_pool_provider",
		after:   map[string]any{}, afterUnknown: map[string]any{"attribute_condition": true},
	}})
	if wif.Status != StatusNotEvaluable {
		t.Errorf("GCP-WIF-001 with a computed condition = %q, want not_evaluable", wif.Status)
	}

	iam := controlGCPLeastPrivilege([]plannedResource{{
		address: "google_project_iam_binding.b", rtype: "google_project_iam_binding",
		after: map[string]any{}, afterUnknown: map[string]any{"role": true},
	}})
	if iam.Status != StatusNotEvaluable {
		t.Errorf("GCP-LEASTPRIV-001 with a computed role = %q, want not_evaluable", iam.Status)
	}

	editor := controlGCPLeastPrivilege([]plannedResource{{
		address: "google_project_iam_member.m", rtype: "google_project_iam_member",
		after: map[string]any{"role": "roles/editor"}, afterUnknown: map[string]any{},
	}})
	if editor.Status != StatusWarn {
		t.Errorf("roles/editor = %q, want warn", editor.Status)
	}
}

// ── Kubernetes control-set helpers ──────────────────────────────────────────

// TestParseCustomerPlanRejections pins the BYO-plan parser: empty, invalid, and
// not-a-plan bytes are refused with an error rather than yielding an empty plan the
// controls would vacuously pass.
func TestParseCustomerPlanRejections(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		wantErr string
	}{
		{name: "empty", in: "", wantErr: "empty plan JSON"},
		{name: "whitespace only", in: "   \n\t ", wantErr: "empty plan JSON"},
		{name: "invalid json", in: "{not json", wantErr: "invalid plan JSON"},
		// A JSON document with no format_version is refused by the plan decoder itself.
		{name: "valid json but not a plan", in: `{"hello":"world"}`, wantErr: "invalid plan JSON"},
		{name: "no format version", in: `{"resource_changes":[]}`, wantErr: "invalid plan JSON"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			plan, err := ParseCustomerPlan([]byte(tc.in))
			if err == nil {
				t.Fatalf("ParseCustomerPlan(%q) returned a plan %+v, want an error", tc.in, plan)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error = %v, want it to mention %q", err, tc.wantErr)
			}
		})
	}

	ok, err := ParseCustomerPlan([]byte(`{"format_version":"1.2","resource_changes":[]}`))
	if err != nil {
		t.Fatalf("a well-formed empty plan must parse: %v", err)
	}
	if ok == nil {
		t.Fatal("ParseCustomerPlan returned a nil plan with no error")
	}
}

// TestEvaluateManifestsRejectsInvalidYAML pins that an undecodable manifest stream is
// an error, not an empty (and therefore vacuously passing) report.
func TestEvaluateManifestsRejectsInvalidYAML(t *testing.T) {
	if _, err := EvaluateManifests([]byte("kind: [unclosed\n")); err == nil {
		t.Fatal("EvaluateManifests accepted invalid YAML")
	}
}

// TestPodSpecShapes pins the pod-template locator across kinds and malformed bodies.
func TestPodSpecShapes(t *testing.T) {
	tests := []struct {
		name string
		res  k8sResource
		want bool
	}{
		{name: "not a workload kind", res: k8sResource{kind: "Service", raw: map[string]any{"spec": map[string]any{}}}},
		{name: "workload with no spec", res: k8sResource{kind: "Deployment", raw: map[string]any{}}},
		{name: "workload with a scalar spec", res: k8sResource{kind: "Deployment", raw: map[string]any{"spec": "nope"}}},
		{name: "workload with no template", res: k8sResource{kind: "Deployment", raw: map[string]any{"spec": map[string]any{}}}},
		{name: "template with no spec", res: k8sResource{kind: "Deployment", raw: map[string]any{"spec": map[string]any{"template": map[string]any{}}}}},
		{
			name: "pod uses its own spec",
			res:  k8sResource{kind: "Pod", raw: map[string]any{"spec": map[string]any{"containers": []any{}}}},
			want: true,
		},
		{
			name: "deployment template spec",
			res: k8sResource{kind: "StatefulSet", raw: map[string]any{
				"spec": map[string]any{"template": map[string]any{"spec": map[string]any{"containers": []any{}}}},
			}},
			want: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, ok := podSpec(tc.res)
			if ok != tc.want {
				t.Errorf("podSpec ok = %v, want %v", ok, tc.want)
			}
		})
	}
}

// TestContainersSkipsMalformedEntries pins that a container list holding non-objects
// contributes nothing rather than panicking.
func TestContainersSkipsMalformedEntries(t *testing.T) {
	ps := map[string]any{
		"containers":     []any{map[string]any{"name": "a"}, "junk"},
		"initContainers": []any{map[string]any{"name": "init"}},
	}
	got := containers(ps)
	if len(got) != 2 {
		t.Fatalf("containers = %d, want 2 (one container + one initContainer)", len(got))
	}
	if n := len(containers(map[string]any{"containers": "not a list"})); n != 0 {
		t.Errorf("containers of a scalar = %d, want 0", n)
	}
}

// TestK8sScalarHelpers pins boolField / asInt / hasStar / lastSegment, the small
// readers every k8s control branches on.
func TestK8sScalarHelpers(t *testing.T) {
	if _, ok := boolField(nil, "privileged"); ok {
		t.Error("boolField on a nil map must report absent")
	}
	if _, ok := boolField(map[string]any{"privileged": "true"}, "privileged"); ok {
		t.Error("boolField must not coerce a string")
	}
	if b, ok := boolField(map[string]any{"privileged": true}, "privileged"); !ok || !b {
		t.Error("boolField failed to read a real bool")
	}

	intTests := map[string]struct {
		in   any
		want int
	}{
		"int":     {in: 0, want: 0},
		"int64":   {in: int64(1000), want: 1000},
		"float64": {in: float64(0), want: 0},
		"string":  {in: "0", want: -1},
		"nil":     {in: nil, want: -1},
	}
	for name, tc := range intTests {
		if got := asInt(tc.in); got != tc.want {
			t.Errorf("asInt(%s) = %d, want %d", name, got, tc.want)
		}
	}

	starTests := map[string]struct {
		in   any
		want bool
	}{
		"not a list":   {in: "*"},
		"empty list":   {in: []any{}},
		"no star":      {in: []any{"get", "list"}},
		"has star":     {in: []any{"get", "*"}, want: true},
		"non-string":   {in: []any{float64(1)}},
		"nil contents": {in: []any{nil}},
	}
	for name, tc := range starTests {
		if got := hasStar(tc.in); got != tc.want {
			t.Errorf("hasStar(%s) = %v, want %v", name, got, tc.want)
		}
	}

	segTests := map[string]string{
		"nginx":                    "nginx",
		"nginx:1.2":                "nginx:1.2",
		"reg.example.com/app:v1":   "app:v1",
		"reg.example.com:5000/app": "app",
	}
	for in, want := range segTests {
		if got := lastSegment(in); got != want {
			t.Errorf("lastSegment(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestRunAsRootAndNonRootReaders pins how the container and pod securityContext are
// read for the root judgement.
func TestRunAsRootAndNonRootReaders(t *testing.T) {
	tests := []struct {
		name        string
		container   map[string]any
		pod         map[string]any
		wantRoot    bool
		wantNonRoot bool
	}{
		{name: "both nil"},
		{name: "container pins zero", container: map[string]any{"runAsUser": float64(0)}, wantRoot: true},
		{name: "pod pins zero", pod: map[string]any{"runAsUser": float64(0)}, wantRoot: true},
		{name: "non-root uid", container: map[string]any{"runAsUser": float64(1000)}},
		{name: "unparseable uid", container: map[string]any{"runAsUser": "root"}},
		{name: "container sets runAsNonRoot", container: map[string]any{"runAsNonRoot": true}, wantNonRoot: true},
		{name: "pod sets runAsNonRoot", pod: map[string]any{"runAsNonRoot": true}, wantNonRoot: true},
		{name: "runAsNonRoot false", container: map[string]any{"runAsNonRoot": false}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := runsAsRoot(tc.container, tc.pod); got != tc.wantRoot {
				t.Errorf("runsAsRoot = %v, want %v", got, tc.wantRoot)
			}
			if got := runAsNonRootSet(tc.container, tc.pod); got != tc.wantNonRoot {
				t.Errorf("runAsNonRootSet = %v, want %v", got, tc.wantNonRoot)
			}
		})
	}
}

// TestControlResourceLimitsWarns pins RESOURCES-001 across a container with no
// resources block, a partial limits block, and a complete one.
func TestControlResourceLimitsWarns(t *testing.T) {
	tests := []struct {
		name       string
		container  map[string]any
		wantStatus Status
	}{
		{name: "no resources block", container: map[string]any{"name": "a"}, wantStatus: StatusWarn},
		{
			name:       "cpu only",
			container:  map[string]any{"name": "a", "resources": map[string]any{"limits": map[string]any{"cpu": "500m"}}},
			wantStatus: StatusWarn,
		},
		{
			name: "both limits",
			container: map[string]any{"name": "a", "resources": map[string]any{
				"limits": map[string]any{"cpu": "500m", "memory": "512Mi"},
			}},
			wantStatus: StatusPass,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := []k8sResource{{kind: "Pod", name: "p", raw: map[string]any{
				"spec": map[string]any{"containers": []any{tc.container}},
			}}}
			c := controlResourceLimits(res)
			if c.Status != tc.wantStatus {
				t.Errorf("status = %q, want %q (findings %+v)", c.Status, tc.wantStatus, c.Findings)
			}
		})
	}
}

// TestControlHostAccessBranches pins HOSTACCESS-001 over each host namespace flag and
// a malformed volumes list.
func TestControlHostAccessBranches(t *testing.T) {
	tests := []struct {
		name       string
		spec       map[string]any
		wantStatus Status
	}{
		{name: "clean", spec: map[string]any{"containers": []any{}}, wantStatus: StatusPass},
		{name: "hostPID", spec: map[string]any{"hostPID": true}, wantStatus: StatusFail},
		{name: "hostIPC", spec: map[string]any{"hostIPC": true}, wantStatus: StatusFail},
		{name: "hostNetwork false", spec: map[string]any{"hostNetwork": false}, wantStatus: StatusPass},
		{name: "volumes not a list", spec: map[string]any{"volumes": "nope"}, wantStatus: StatusPass},
		{name: "volume entry not an object", spec: map[string]any{"volumes": []any{"nope"}}, wantStatus: StatusPass},
		{
			name:       "emptyDir volume is fine",
			spec:       map[string]any{"volumes": []any{map[string]any{"name": "cache", "emptyDir": map[string]any{}}}},
			wantStatus: StatusPass,
		},
		{
			name:       "hostPath volume",
			spec:       map[string]any{"volumes": []any{map[string]any{"name": "host", "hostPath": map[string]any{"path": "/"}}}},
			wantStatus: StatusFail,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := controlHostAccess([]k8sResource{{kind: "Pod", name: "p", raw: map[string]any{"spec": tc.spec}}})
			if c.Status != tc.wantStatus {
				t.Errorf("status = %q, want %q (findings %+v)", c.Status, tc.wantStatus, c.Findings)
			}
		})
	}
}

// TestControlRBACMalformedShapes pins that RBAC-001 tolerates rules/subjects that are
// not the shape it expects, and that a partial wildcard is not cluster-admin.
func TestControlRBACMalformedShapes(t *testing.T) {
	tests := []struct {
		name       string
		res        k8sResource
		wantStatus Status
	}{
		{name: "rules not a list", res: k8sResource{kind: "Role", name: "r", raw: map[string]any{"rules": "nope"}}, wantStatus: StatusPass},
		{name: "rule not an object", res: k8sResource{kind: "Role", name: "r", raw: map[string]any{"rules": []any{"nope"}}}, wantStatus: StatusPass},
		{
			name: "partial wildcard is not cluster-admin",
			res: k8sResource{kind: "ClusterRole", name: "r", raw: map[string]any{"rules": []any{
				map[string]any{"verbs": []any{"*"}, "resources": []any{"secrets"}, "apiGroups": []any{""}},
			}}},
			wantStatus: StatusPass,
		},
		{name: "subjects not a list", res: k8sResource{kind: "RoleBinding", name: "b", raw: map[string]any{"subjects": "nope"}}, wantStatus: StatusPass},
		{name: "subject not an object", res: k8sResource{kind: "RoleBinding", name: "b", raw: map[string]any{"subjects": []any{"nope"}}}, wantStatus: StatusPass},
		{
			name: "named user is fine",
			res: k8sResource{kind: "ClusterRoleBinding", name: "b", raw: map[string]any{"subjects": []any{
				map[string]any{"kind": "User", "name": "alice@example.test"},
			}}},
			wantStatus: StatusPass,
		},
		{
			name: "system:unauthenticated binding fails",
			res: k8sResource{kind: "ClusterRoleBinding", name: "b", raw: map[string]any{"subjects": []any{
				map[string]any{"kind": "Group", "name": "system:unauthenticated"},
			}}},
			wantStatus: StatusFail,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := controlRBAC([]k8sResource{tc.res})
			if c.Status != tc.wantStatus {
				t.Errorf("status = %q, want %q (findings %+v)", c.Status, tc.wantStatus, c.Findings)
			}
		})
	}
}

// ── Access Analyzer corroboration ───────────────────────────────────────────

// TestAccessAnalyzerCoverageGaps pins that a policy body the checker cannot see — a
// computed one or an empty one — is a coverage gap, never a silent pass.
func TestAccessAnalyzerCoverageGaps(t *testing.T) {
	tests := []struct {
		name         string
		after        map[string]any
		unknown      any
		wantStatus   Status
		wantCoverage string
	}{
		{
			name: "computed policy body", after: map[string]any{},
			unknown: map[string]any{"policy": true}, wantStatus: StatusNotEvaluable,
			wantCoverage: "policy body computed until apply",
		},
		{
			name: "empty policy body", after: map[string]any{"policy": ""},
			unknown: map[string]any{}, wantStatus: StatusNotEvaluable,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := controlAccessAnalyzer(context.Background(),
				[]plannedResource{{address: "aws_iam_policy.p", rtype: "aws_iam_policy", after: tc.after, afterUnknown: tc.unknown}},
				fakeChecker{}, DefaultDeniedActions)
			if c.Status != tc.wantStatus {
				t.Fatalf("status = %q (coverage %q), want %q", c.Status, c.Coverage, tc.wantStatus)
			}
			if tc.wantCoverage != "" && !strings.Contains(c.Coverage, tc.wantCoverage) {
				t.Errorf("coverage = %q, want it to mention %q", c.Coverage, tc.wantCoverage)
			}
		})
	}
}

// TestAccessAnalyzerRunsOnAnUnrecognizedPlan pins the fail-closed default: with a
// checker configured and no cloud recognized, the analyzer control still runs.
func TestAccessAnalyzerRunsOnAnUnrecognizedPlan(t *testing.T) {
	plan := mustPlan(t, `{
      "format_version": "1.2",
      "resource_changes": [
        {"address":"awscc_iam_role.r","mode":"managed","type":"awscc_iam_role","name":"r",
         "change":{"actions":["create"],"after":{"name":"r"},"after_unknown":{}}}
      ]}`)
	rep, err := EvaluateWithOptions(context.Background(), plan, Options{PolicyChecker: fakeChecker{}})
	if err != nil {
		t.Fatal(err)
	}
	// Both the analyzer control and the fail-closed scope backstop must be present.
	controlByID(t, rep, "ACCESS-ANALYZER-001")
	controlByID(t, rep, "SCOPE-001")
	if rep.Verdict != StatusNotEvaluable {
		t.Errorf("verdict = %q, want not_evaluable (an unrecognized provider is never a vacuous pass)", rep.Verdict)
	}
}

// ── Receipt signing, trust binding and the Rekor anchor ─────────────────────

// TestSignRejectsAMalformedPrivateKey pins the length guard on the raw-key signer.
func TestSignRejectsAMalformedPrivateKey(t *testing.T) {
	if _, err := Sign(Receipt{Version: ReceiptVersion}, ed25519.PrivateKey("too short"), "kid"); err == nil {
		t.Fatal("Sign accepted a malformed private key")
	}
	if _, err := NewInProcessSigner(ed25519.PrivateKey(nil)); err == nil {
		t.Fatal("NewInProcessSigner accepted a nil private key")
	}
}

// TestVerifyErrorBranches pins every fail-closed refusal of SignedReceipt.Verify and
// VerifySelf — a receipt that cannot be checked is never treated as verified.
func TestVerifyErrorBranches(t *testing.T) {
	pub, priv := newKey(t)
	good, err := Sign(Receipt{Version: ReceiptVersion, Runner: "r"}, priv, KeyID(pub))
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	var nilReceipt *SignedReceipt
	if err := nilReceipt.Verify(pub); err == nil {
		t.Error("Verify on a nil receipt must error")
	}
	if err := nilReceipt.VerifySelf(); err == nil {
		t.Error("VerifySelf on a nil receipt must error")
	}
	if err := nilReceipt.VerifyTrusted(staticTrustedKeys{}); err == nil {
		t.Error("VerifyTrusted on a nil receipt must error")
	}

	tests := []struct {
		name   string
		mutate func(sr *SignedReceipt)
		pub    ed25519.PublicKey
		want   string
	}{
		{name: "wrong algorithm", mutate: func(sr *SignedReceipt) { sr.Algorithm = "rsa" }, pub: pub, want: "unsupported signature algorithm"},
		{name: "short public key", pub: ed25519.PublicKey("short"), want: "invalid ed25519 public key length"},
		{name: "signature is not base64", mutate: func(sr *SignedReceipt) { sr.Signature = "!!!not base64!!!" }, pub: pub, want: "decode signature"},
		{name: "tampered receipt", mutate: func(sr *SignedReceipt) { sr.Receipt.Runner = "someone-else" }, pub: pub, want: "does not match receipt"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			sr := *good
			if tc.mutate != nil {
				tc.mutate(&sr)
			}
			err := sr.Verify(tc.pub)
			if err == nil {
				t.Fatalf("Verify accepted %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error = %v, want it to mention %q", err, tc.want)
			}
		})
	}

	unsigned := *good
	unsigned.PublicKey = ""
	if err := unsigned.VerifySelf(); err == nil || !strings.Contains(err.Error(), "no embedded public key") {
		t.Errorf("VerifySelf with no embedded key = %v, want a refusal", err)
	}
	badB64 := *good
	badB64.PublicKey = "!!!not base64!!!"
	if err := badB64.VerifySelf(); err == nil || !strings.Contains(err.Error(), "decode embedded public key") {
		t.Errorf("VerifySelf with an undecodable key = %v, want a refusal", err)
	}
}

// staticTrustedKeys is a deterministic TrustedKeys backed by an in-memory map.
type staticTrustedKeys map[string]ed25519.PublicKey

// PublicKeyForKeyID resolves a key id to its recorded public key.
func (s staticTrustedKeys) PublicKeyForKeyID(keyID string) (ed25519.PublicKey, bool) {
	pub, ok := s[keyID]
	return pub, ok
}

// TestVerifyTrustedRefusals pins the two fail-closed refusals of VerifyTrusted: no key
// source at all, and a key_id absent from the recorded history.
func TestVerifyTrustedRefusals(t *testing.T) {
	pub, priv := newKey(t)
	sr, err := Sign(Receipt{Version: ReceiptVersion}, priv, KeyID(pub))
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if err := sr.VerifyTrusted(nil); err == nil || !strings.Contains(err.Error(), "nil trusted-key source") {
		t.Errorf("VerifyTrusted(nil) = %v, want a refusal", err)
	}
	if err := sr.VerifyTrusted(staticTrustedKeys{}); err == nil || !strings.Contains(err.Error(), "no trusted public key") {
		t.Errorf("VerifyTrusted with an unknown key_id = %v, want a refusal", err)
	}
	if err := sr.VerifyTrusted(staticTrustedKeys{KeyID(pub): pub}); err != nil {
		t.Errorf("VerifyTrusted with the recorded key = %v, want success", err)
	}
}

// brokenSigner is a Signer whose parts can each be made inconsistent, so
// SignReceiptWith's fail-closed checks are exercised without a real key backend.
type brokenSigner struct {
	err  error
	sig  []byte
	pub  ed25519.PublicKey
	kid  string
	real *InProcessSigner
}

// Sign returns the configured error or signature.
func (b brokenSigner) Sign(canonical []byte) ([]byte, error) {
	if b.err != nil {
		return nil, b.err
	}
	if b.sig != nil {
		return b.sig, nil
	}
	return b.real.Sign(canonical)
}

// Public returns the configured public key.
func (b brokenSigner) Public() ed25519.PublicKey {
	if b.pub != nil {
		return b.pub
	}
	return b.real.Public()
}

// KeyID returns the configured key id.
func (b brokenSigner) KeyID() string {
	if b.kid != "" {
		return b.kid
	}
	return b.real.KeyID()
}

// TestSignReceiptWithFailsClosed pins that SignReceiptWith never emits a receipt whose
// signature its own reported public key cannot verify.
func TestSignReceiptWithFailsClosed(t *testing.T) {
	_, priv := newKey(t)
	real, err := NewInProcessSigner(priv)
	if err != nil {
		t.Fatalf("NewInProcessSigner: %v", err)
	}
	otherPub, _ := newKey(t)

	if _, err := SignReceiptWith(Receipt{}, nil); err == nil || !strings.Contains(err.Error(), "nil signer") {
		t.Errorf("SignReceiptWith(nil signer) = %v, want a refusal", err)
	}

	tests := []struct {
		name   string
		signer Signer
		want   string
	}{
		{name: "signer errors", signer: brokenSigner{real: real, err: errors.New("kms unavailable")}, want: "sign receipt"},
		{name: "malformed public key", signer: brokenSigner{real: real, pub: ed25519.PublicKey("short")}, want: "invalid ed25519 public key length"},
		{name: "signature does not verify", signer: brokenSigner{real: real, pub: otherPub}, want: "does not verify"},
		{name: "garbage signature", signer: brokenSigner{real: real, sig: make([]byte, ed25519.SignatureSize)}, want: "does not verify"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			sr, err := SignReceiptWith(Receipt{Version: ReceiptVersion}, tc.signer)
			if err == nil {
				t.Fatalf("SignReceiptWith emitted %+v, want a refusal", sr)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error = %v, want it to mention %q", err, tc.want)
			}
		})
	}
}

// TestSigningBackendClosedSet pins the backend enum against the pg enum it mirrors.
func TestSigningBackendClosedSet(t *testing.T) {
	if len(AllSigningBackends) != 2 {
		t.Fatalf("AllSigningBackends = %v, want exactly kms + secret", AllSigningBackends)
	}
	for _, b := range AllSigningBackends {
		if !b.Valid() {
			t.Errorf("%q is listed but not Valid()", b)
		}
	}
	if SigningBackend("vault").Valid() {
		t.Error("an unknown backend must not be Valid()")
	}
}

// TestSigningKeyFromEnvWrongLength pins the length guard on the platform signing key:
// a well-formed base64 blob of the wrong size is an error, never a usable key.
func TestSigningKeyFromEnvWrongLength(t *testing.T) {
	t.Setenv(SigningKeyEnv, base64.StdEncoding.EncodeToString(make([]byte, 16)))
	priv, keyID, ok, err := SigningKeyFromEnv()
	if err == nil {
		t.Fatal("SigningKeyFromEnv accepted a 16-byte key")
	}
	if ok || priv != nil || keyID != "" {
		t.Errorf("ok=%v priv=%v keyID=%q, want a clean refusal", ok, priv, keyID)
	}
	if !strings.Contains(err.Error(), "ed25519 private key") {
		t.Errorf("error = %v, want it to name the expected key size", err)
	}
}

// TestVerifyInclusionRejections pins the RFC 6962 audit-path checks: an out-of-range
// index, a malformed hash, and a proof of the wrong length are all refused.
func TestVerifyInclusionRejections(t *testing.T) {
	leaf := rfc6962LeafHash([]byte("leaf"))
	sibling := rfc6962LeafHash([]byte("sibling"))
	root := rfc6962NodeHash(leaf, sibling)
	goodProof := []string{hex.EncodeToString(sibling)}

	tests := []struct {
		name      string
		index     int64
		treeSize  int64
		proof     []string
		root      []byte
		wantError string
	}{
		{name: "negative index", index: -1, treeSize: 2, proof: goodProof, root: root, wantError: "negative index"},
		{name: "negative tree size", index: 0, treeSize: -1, proof: goodProof, root: root, wantError: "negative index"},
		{name: "index out of range", index: 2, treeSize: 2, proof: goodProof, root: root, wantError: "out of range"},
		{name: "audit hash is not hex", index: 0, treeSize: 2, proof: []string{"zzzz"}, root: root, wantError: "decode audit hash"},
		{name: "audit hash is the wrong size", index: 0, treeSize: 2, proof: []string{"aabb"}, root: root, wantError: "want 32"},
		{name: "proof too short", index: 0, treeSize: 2, proof: nil, root: root, wantError: "want 1"},
		{name: "wrong root", index: 0, treeSize: 2, proof: goodProof, root: leaf, wantError: "does not match claimed root"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := verifyInclusion(tc.index, tc.treeSize, leaf, tc.proof, tc.root)
			if err == nil {
				t.Fatalf("verifyInclusion accepted %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.wantError) {
				t.Errorf("error = %v, want it to mention %q", err, tc.wantError)
			}
		})
	}

	if err := verifyInclusion(0, 2, leaf, goodProof, root); err != nil {
		t.Errorf("a valid two-leaf proof was rejected: %v", err)
	}
	if err := verifyInclusion(0, 1, leaf, nil, leaf); err != nil {
		t.Errorf("a single-leaf tree was rejected: %v", err)
	}
}

// TestParseCheckpointRejections pins the signed-note reader used for the defence-in-
// depth checkpoint cross-check.
func TestParseCheckpointRejections(t *testing.T) {
	tests := []struct {
		name       string
		checkpoint string
		wantError  string
	}{
		{name: "too few lines", checkpoint: "origin\n12", wantError: "want at least origin, size, root"},
		{name: "size is not a number", checkpoint: "origin\nnotanumber\nAAAA\n", wantError: "tree size"},
		{name: "root is not base64", checkpoint: "origin\n12\n!!!!\n", wantError: "root hash"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := parseCheckpoint(tc.checkpoint)
			if err == nil {
				t.Fatalf("parseCheckpoint accepted %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.wantError) {
				t.Errorf("error = %v, want it to mention %q", err, tc.wantError)
			}
		})
	}

	root := make([]byte, 32)
	cp := "rekor.example - 1\n7\n" + base64.StdEncoding.EncodeToString(root) + "\n\n— rekor.example sig\n"
	size, gotRoot, err := parseCheckpoint(cp)
	if err != nil {
		t.Fatalf("parseCheckpoint of a well-formed note: %v", err)
	}
	if size != 7 || len(gotRoot) != 32 {
		t.Errorf("size = %d, root len = %d, want 7 and 32", size, len(gotRoot))
	}
}

// TestParseRekorLogKeyRejections pins the deployer-pinned log-key parser.
func TestParseRekorLogKeyRejections(t *testing.T) {
	if _, err := ParseRekorLogKey([]byte("not pem at all")); err == nil {
		t.Error("ParseRekorLogKey accepted non-PEM bytes")
	}
	if _, err := ParseRekorLogKey([]byte("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n")); err == nil {
		t.Error("ParseRekorLogKey accepted a PEM block that is not a PKIX key")
	}

	ed25519Pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	if _, err := ParseRekorLogKey(marshalAnyPubPEM(t, ed25519Pub)); err == nil {
		t.Error("ParseRekorLogKey accepted a non-ECDSA key")
	}

	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	parsed, err := ParseRekorLogKey(marshalAnyPubPEM(t, &ecKey.PublicKey))
	if err != nil {
		t.Fatalf("ParseRekorLogKey of a real P-256 key: %v", err)
	}
	if !parsed.Equal(&ecKey.PublicKey) {
		t.Error("ParseRekorLogKey returned a different key")
	}
}

// TestDecodeECDSAPublicKeyB64PEMRejections pins the anchor public-key decoder.
func TestDecodeECDSAPublicKeyB64PEMRejections(t *testing.T) {
	ed25519Pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	tests := []struct {
		name      string
		in        string
		wantError string
	}{
		{name: "not base64", in: "!!!!", wantError: "not valid base64"},
		{name: "not pem", in: base64.StdEncoding.EncodeToString([]byte("plain bytes")), wantError: "not PEM-encoded"},
		{
			name:      "not a pkix key",
			in:        base64.StdEncoding.EncodeToString([]byte("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n")),
			wantError: "parse PKIX public key",
		},
		{
			name:      "not ecdsa",
			in:        base64.StdEncoding.EncodeToString(marshalAnyPubPEM(t, ed25519Pub)),
			wantError: "not ECDSA",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := decodeECDSAPublicKeyB64PEM(tc.in)
			if err == nil {
				t.Fatalf("decodeECDSAPublicKeyB64PEM accepted %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.wantError) {
				t.Errorf("error = %v, want it to mention %q", err, tc.wantError)
			}
		})
	}
}

// TestVerifyAnchorMalformedFields pins the fail-closed refusals VerifyAnchor makes
// while binding a receipt to its logged entry — every one of them must error.
func TestVerifyAnchorMalformedFields(t *testing.T) {
	r := Receipt{Version: ReceiptVersion, Runner: "runner-1", CatalogVersion: CatalogVersion}
	base, logKey := buildTestAnchor(t, r, 0)

	tests := []struct {
		name      string
		mutate    func(a *RekorAnchor)
		wantError string
	}{
		{name: "anchor key is not base64", mutate: func(a *RekorAnchor) { a.AnchorPublicKey = "!!!!" }, wantError: "anchor public key"},
		{name: "anchor signature is not base64", mutate: func(a *RekorAnchor) { a.AnchorSignature = "!!!!" }, wantError: "decode anchor signature"},
		{name: "body is not base64", mutate: func(a *RekorAnchor) { a.Body = "!!!!" }, wantError: "decode rekor body"},
		{
			name:      "body is not json",
			mutate:    func(a *RekorAnchor) { a.Body = base64.StdEncoding.EncodeToString([]byte("not json")) },
			wantError: "parse rekor body",
		},
		{
			name:      "body is the wrong kind",
			mutate:    func(a *RekorAnchor) { a.Body = base64.StdEncoding.EncodeToString([]byte(`{"kind":"rekord"}`)) },
			wantError: "unexpected rekor entry kind",
		},
		{name: "no signed entry timestamp", mutate: func(a *RekorAnchor) { a.SignedEntryTimestamp = "" }, wantError: "no signed entry timestamp"},
		{name: "SET is not base64", mutate: func(a *RekorAnchor) { a.SignedEntryTimestamp = "!!!!" }, wantError: "decode signed entry timestamp"},
		{name: "SET covers a different log index", mutate: func(a *RekorAnchor) { a.LogIndex += 1 }, wantError: "signed entry timestamp does not verify"},
		{name: "root hash is not hex", mutate: func(a *RekorAnchor) { a.InclusionProof.RootHash = "zzzz" }, wantError: "decode inclusion root hash"},
		{
			name: "checkpoint disagrees with the proof",
			mutate: func(a *RekorAnchor) {
				a.InclusionProof.Checkpoint = "origin\n999\n" + base64.StdEncoding.EncodeToString(make([]byte, 32)) + "\n\nsig\n"
			},
			wantError: "checkpoint tree head does not match",
		},
		{
			name:      "checkpoint is malformed",
			mutate:    func(a *RekorAnchor) { a.InclusionProof.Checkpoint = "origin\nnotanumber\nAAAA\n\nsig\n" },
			wantError: "checkpoint",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a := *base
			tc.mutate(&a)
			err := VerifyAnchor(r, &a, logKey)
			if err == nil {
				t.Fatalf("VerifyAnchor accepted %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.wantError) {
				t.Errorf("error = %v, want it to mention %q", err, tc.wantError)
			}
		})
	}
}

// TestVerifyAnchorRejectsAMismatchedLoggedEntry pins the binding between the logged
// hashedrekord body and the anchor: a body that names a different digest, signature or
// public key must not verify even though the log signed it.
func TestVerifyAnchorRejectsAMismatchedLoggedEntry(t *testing.T) {
	r := Receipt{Version: ReceiptVersion, Runner: "runner-1"}
	base, logKey := buildTestAnchor(t, r, 1)

	tests := []struct {
		name      string
		swap      func(body map[string]any)
		wantError string
	}{
		{
			name: "hash algorithm is not sha256",
			swap: func(body map[string]any) {
				spec, _ := body["spec"].(map[string]any)
				data, _ := spec["data"].(map[string]any)
				hash, _ := data["hash"].(map[string]any)
				hash["algorithm"] = "sha512"
			},
			wantError: "logged entry hash does not match",
		},
		{
			name: "hash value is a different digest",
			swap: func(body map[string]any) {
				spec, _ := body["spec"].(map[string]any)
				data, _ := spec["data"].(map[string]any)
				hash, _ := data["hash"].(map[string]any)
				hash["value"] = hex.EncodeToString(make([]byte, 32))
			},
			wantError: "logged entry hash does not match",
		},
		{
			name: "signature content differs",
			swap: func(body map[string]any) {
				spec, _ := body["spec"].(map[string]any)
				sig, _ := spec["signature"].(map[string]any)
				sig["content"] = base64.StdEncoding.EncodeToString([]byte("other"))
			},
			wantError: "logged entry signature does not match",
		},
		{
			name: "public key content differs",
			swap: func(body map[string]any) {
				spec, _ := body["spec"].(map[string]any)
				sig, _ := spec["signature"].(map[string]any)
				pk, _ := sig["publicKey"].(map[string]any)
				pk["content"] = base64.StdEncoding.EncodeToString([]byte("other"))
			},
			wantError: "logged entry public key does not match",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a := *base
			a.Body = rewriteRekorBody(t, base.Body, tc.swap)
			err := VerifyAnchor(r, &a, logKey)
			if err == nil {
				t.Fatalf("VerifyAnchor accepted %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.wantError) {
				t.Errorf("error = %v, want it to mention %q", err, tc.wantError)
			}
		})
	}
}

// marshalAnyPubPEM PEM-encodes any PKIX-marshalable public key, so the parsers can be
// fed a well-formed PEM block that is nevertheless the wrong key type.
func marshalAnyPubPEM(t *testing.T, pub crypto.PublicKey) []byte {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatalf("marshal pub: %v", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
}

// rewriteRekorBody decodes a base64 hashedrekord body, applies swap to it, and
// re-encodes it — so a test can log an entry that does NOT bind to the anchor.
func rewriteRekorBody(t *testing.T, bodyB64 string, swap func(body map[string]any)) string {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(bodyB64)
	if err != nil {
		t.Fatalf("decode body: %v", err)
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("unmarshal body: %v", err)
	}
	swap(body)
	out, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	return base64.StdEncoding.EncodeToString(out)
}
