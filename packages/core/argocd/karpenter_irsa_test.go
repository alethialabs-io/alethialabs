// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"errors"
	"testing"

	"gopkg.in/yaml.v3"
)

// testKarpenterRoleArn is the shape module.irsa_karpenter's iam_role_arn takes
// (role_name = "KarpenterIRSA-${local.eks_name}"), exported as the `karpenter_sa_role` output.
const testKarpenterRoleArn = "arn:aws:iam::acct-123:role/KarpenterIRSA-eks-demo"

// karpenterApp is the slice of the rendered Karpenter Application these tests read.
type karpenterApp struct {
	Spec struct {
		Source struct {
			Helm struct {
				Values string `yaml:"values"`
			} `yaml:"helm"`
		} `yaml:"source"`
		Destination struct {
			Namespace string `yaml:"namespace"`
		} `yaml:"destination"`
	} `yaml:"spec"`
}

// karpenterValues is the slice of the chart values these tests read.
type karpenterValues struct {
	ServiceAccount struct {
		Create      bool              `yaml:"create"`
		Name        string            `yaml:"name"`
		Annotations map[string]string `yaml:"annotations"`
	} `yaml:"serviceAccount"`
}

// parseKarpenter decodes the rendered karpenter.yaml down to its chart values.
func parseKarpenter(t *testing.T, doc string) (karpenterApp, karpenterValues) {
	t.Helper()
	var app karpenterApp
	if err := yaml.Unmarshal([]byte(doc), &app); err != nil {
		t.Fatalf("karpenter.yaml is not YAML: %v\n%s", err, doc)
	}
	var vals karpenterValues
	if err := yaml.Unmarshal([]byte(app.Spec.Source.Helm.Values), &vals); err != nil {
		t.Fatalf("karpenter chart values are not YAML: %v\n%s", err, app.Spec.Source.Helm.Values)
	}
	return app, vals
}

// TestBuildFromOutputs_ReadsKarpenterRole pins the output → fact wiring for `karpenter_sa_role`,
// and that no other cloud reads it.
func TestBuildFromOutputs_ReadsKarpenterRole(t *testing.T) {
	outputs := map[string]interface{}{"eks_cluster_name": "eks-demo", "karpenter_sa_role": testKarpenterRoleArn}
	if got := BuildFromOutputs(outputs, cfg("aws")).KarpenterRoleArn; got != testKarpenterRoleArn {
		t.Errorf("aws KarpenterRoleArn = %q, want %q", got, testKarpenterRoleArn)
	}
	// The tofu-JSON wrapped form ({"value": …}) is what a state read hands over.
	wrapped := map[string]interface{}{"karpenter_sa_role": map[string]interface{}{"value": testKarpenterRoleArn}}
	if got := BuildFromOutputs(wrapped, cfg("aws")).KarpenterRoleArn; got != testKarpenterRoleArn {
		t.Errorf("aws KarpenterRoleArn from wrapped output = %q, want %q", got, testKarpenterRoleArn)
	}
	if got := BuildFromOutputs(outputs, cfg("gcp")).KarpenterRoleArn; got != "" {
		t.Errorf("gcp must not read an aws output, got KarpenterRoleArn = %q", got)
	}
}

// TestRender_KarpenterServiceAccountCarriesIRSARole pins the annotation (#6559): the chart's
// ServiceAccount is created as karpenter in the karpenter namespace — the exact subject the IRSA
// role's trust policy names (`karpenter:karpenter`, project/aws/irsa.tf) — and carries the role ARN.
func TestRender_KarpenterServiceAccountCarriesIRSARole(t *testing.T) {
	files := renderAll(t, BuildFromOutputs(map[string]interface{}{
		"eks_cluster_name":  "eks-demo",
		"karpenter_sa_role": testKarpenterRoleArn,
	}, cfg("aws")))
	doc, ok := files["karpenter.yaml"]
	if !ok {
		t.Fatalf("karpenter should render on AWS with enable_karpenter=true")
	}
	app, vals := parseKarpenter(t, doc)
	if got := vals.ServiceAccount.Annotations["eks.amazonaws.com/role-arn"]; got != testKarpenterRoleArn {
		t.Errorf("serviceAccount.annotations[eks.amazonaws.com/role-arn] = %q, want %q\n%s",
			got, testKarpenterRoleArn, app.Spec.Source.Helm.Values)
	}
	subject := app.Spec.Destination.Namespace + ":" + vals.ServiceAccount.Name
	if !vals.ServiceAccount.Create || subject != "karpenter:karpenter" {
		t.Errorf("chart ServiceAccount = %s (create=%v), want karpenter:karpenter created by the chart — "+
			"the IRSA trust policy names exactly that subject", subject, vals.ServiceAccount.Create)
	}
}

// TestRender_KarpenterWithoutRoleRefuses pins the refusal: an enabled Karpenter whose role output is
// absent, null or blank fails the render with the named reason, instead of installing a controller
// with no AWS identity.
func TestRender_KarpenterWithoutRoleRefuses(t *testing.T) {
	for name, outputs := range map[string]map[string]interface{}{
		"absent": {"eks_cluster_name": "eks-demo"},
		"null":   {"eks_cluster_name": "eks-demo", "karpenter_sa_role": nil},
		"blank":  {"eks_cluster_name": "eks-demo", "karpenter_sa_role": "  "},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := RenderApplications(templatesDir(t), BuildFromOutputs(outputs, cfg("aws")))
			if !errors.Is(err, ErrKarpenterRoleMissing) {
				t.Fatalf("RenderApplications() error = %v, want ErrKarpenterRoleMissing", err)
			}
		})
	}
}

// TestRender_NoKarpenterNeedsNoRole is the other side of the refusal: it is scoped to the install
// gate, so a deploy that does not render Karpenter never needs the role.
func TestRender_NoKarpenterNeedsNoRole(t *testing.T) {
	off := cfg("aws")
	off.Cluster.ProviderConfig = map[string]any{"enable_karpenter": false}
	files := renderAll(t, BuildFromOutputs(map[string]interface{}{"eks_cluster_name": "eks-demo"}, off))
	if _, ok := files["karpenter.yaml"]; ok {
		t.Errorf("karpenter must not render with enable_karpenter=false")
	}
	// enable_karpenter=true on a cloud that has no Karpenter renders none and refuses nothing.
	files = renderAll(t, BuildFromOutputs(map[string]interface{}{"gke_cluster_name": "gke-demo"}, cfg("gcp")))
	if _, ok := files["karpenter.yaml"]; ok {
		t.Errorf("karpenter must not render on gcp")
	}
}
