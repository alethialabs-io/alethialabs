// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/drift"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	tfjson "github.com/hashicorp/terraform-json"
)

// The cluster the aws drift fixture (packages/core/drift/testdata/aws_fabric_refresh.json, #845 run
// 36717544116) was scanned against, and the binding the fabric demo's LoadBalancer Service leaves in
// it. The binding is COMPOSED from the controller's CR shape — see drift/k8sowned_test.go.
const (
	fixtureEKS = "eks-ue1-36717544116-1-alethia-nl"
	tgbList    = `{"kind":"List","items":[{"metadata":{"namespace":"online-boutique","name":"k8s-onlinebo-frontend"},
		"spec":{"serviceRef":{"name":"frontend-external","port":80},"networking":{"ingress":[{
		"from":[{"securityGroup":{"groupID":"sg-05c00a67233505738"}}],
		"ports":[{"protocol":"TCP","port":31762},{"protocol":"TCP","port":8080}]}]}}}]}`
	svcList = `{"kind":"List","items":[{"metadata":{"namespace":"online-boutique","name":"frontend-external"}}]}`
)

// fakeCluster stands in for kubeconfig acquisition and kubectl for one test.
type fakeCluster struct {
	configureErr error
	reads        map[string]string // resource -> stdout
	readErrs     map[string]error  // resource -> error
	calls        [][]string
	configured   map[string]interface{}
}

// install swaps the package's cluster access for f until the test ends.
func (f *fakeCluster) install(t *testing.T) {
	t.Helper()
	origRead, origConf := kubectlRead, configureClusterKubeconfig
	t.Cleanup(func() { kubectlRead, configureClusterKubeconfig = origRead, origConf })
	configureClusterKubeconfig = func(_ context.Context, _ *types.ProjectConfig, _ string, outputs map[string]interface{}, _ io.Writer) error {
		f.configured = outputs
		return f.configureErr
	}
	kubectlRead = func(ctx context.Context, timeout time.Duration, args ...string) (string, error) {
		if _, ok := ctx.Deadline(); !ok || timeout <= 0 || timeout > clusterEvidenceBudget {
			t.Errorf("kubectl %v ran unbounded (timeout %s)", args, timeout)
		}
		f.calls = append(f.calls, args)
		if err := f.readErrs[args[1]]; err != nil {
			return "", err
		}
		return f.reads[args[1]], nil
	}
}

// healthyCluster is the cluster the fabric demo leaves behind.
func healthyCluster() *fakeCluster {
	return &fakeCluster{reads: map[string]string{"targetgroupbindings.elbv2.k8s.aws": tgbList, "services": svcList}}
}

// awsVC is an aws environment whose configured cluster name is the fixture's.
func awsVC() *types.ProjectConfig {
	vc := &types.ProjectConfig{}
	vc.Cluster.ClusterName = fixtureEKS
	return vc
}

// loadDriftFixture reads the drift package's captured aws plan and schemas.
func loadDriftFixture(t *testing.T) (*tfjson.Plan, *tfjson.ProviderSchemas) {
	t.Helper()
	var plan tfjson.Plan
	var schemas tfjson.ProviderSchemas
	for file, into := range map[string]any{"aws_fabric_refresh.json": &plan, "aws_provider_schemas.json": &schemas} {
		b, err := os.ReadFile(filepath.Join("..", "drift", "testdata", file))
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		if err := json.Unmarshal(b, into); err != nil {
			t.Fatalf("decode %s: %v", file, err)
		}
	}
	return &plan, &schemas
}

func TestClusterEvidenceReaderIsAWSOnly(t *testing.T) {
	for _, p := range []string{"gcp", "azure", "hetzner", "alibaba", ""} {
		if ClusterEvidenceReader(awsVC(), p, io.Discard) != nil {
			t.Errorf("%q: a reader with no consumer must not exist", p)
		}
	}
	if ClusterEvidenceReader(nil, "aws", io.Discard) != nil {
		t.Error("no config: no reader")
	}
	f := healthyCluster()
	f.install(t)
	ev, err := ClusterEvidenceReader(awsVC(), "aws", io.Discard)(context.Background(), nil)
	if err != nil || ev.Bindings() != 1 {
		t.Fatalf("aws reader: %v, %d bindings", err, ev.Bindings())
	}
}

// TestReadClusterEvidenceReadsBothListsCluster-wide pins what is read: every namespace's bindings and
// Services, as JSON, after kubeconfig is acquired for the named cluster.
func TestReadClusterEvidenceReadsBothListsClusterWide(t *testing.T) {
	f := healthyCluster()
	f.install(t)
	outputs := map[string]interface{}{"eks_cluster_name": map[string]interface{}{"value": fixtureEKS}}
	ev, err := readClusterEvidence(context.Background(), &types.ProjectConfig{}, "aws", outputs, io.Discard)
	if err != nil || ev.Bindings() != 1 {
		t.Fatalf("got %v, %d bindings", err, ev.Bindings())
	}
	want := []string{
		"get targetgroupbindings.elbv2.k8s.aws --all-namespaces -o json",
		"get services --all-namespaces -o json",
	}
	if len(f.calls) != 2 || strings.Join(f.calls[0], " ") != want[0] || strings.Join(f.calls[1], " ") != want[1] {
		t.Fatalf("kubectl calls = %v, want %v", f.calls, want)
	}
	if len(outputs) != 1 {
		t.Error("the caller's outputs map was modified")
	}
}

// TestReadClusterEvidenceFailsClosed: every failure is an error and yields no evidence — in
// particular a failed bindings read (no CRD, no access) is never read as "no bindings".
func TestReadClusterEvidenceFailsClosed(t *testing.T) {
	boom := errors.New("Unable to connect to the server")
	for name, c := range map[string]struct {
		vc     *types.ProjectConfig
		mutate func(f *fakeCluster)
	}{
		"no cluster name anywhere": {vc: &types.ProjectConfig{}},
		"kubeconfig fails":         {mutate: func(f *fakeCluster) { f.configureErr = boom }},
		"bindings read fails (no CRD, no access)": {mutate: func(f *fakeCluster) {
			f.readErrs = map[string]error{"targetgroupbindings.elbv2.k8s.aws": boom}
		}},
		"services read fails": {mutate: func(f *fakeCluster) { f.readErrs = map[string]error{"services": boom} }},
		"bindings read is not a list": {mutate: func(f *fakeCluster) {
			f.reads["targetgroupbindings.elbv2.k8s.aws"] = `error: the server doesn't have a resource type "targetgroupbindings"`
		}},
	} {
		t.Run(name, func(t *testing.T) {
			f := healthyCluster()
			if c.mutate != nil {
				c.mutate(f)
			}
			f.install(t)
			vc := c.vc
			if vc == nil {
				vc = awsVC()
			}
			ev, err := readClusterEvidence(context.Background(), vc, "aws", nil, io.Discard)
			if err == nil || ev != nil {
				t.Fatalf("want an error and no evidence, got %v, %+v", err, ev)
			}
		})
	}
}

// TestApplyClusterEvidenceMakesTheCapturedRunInSync is the end of the chain against the captured
// run: with the binding in the cluster, the one drift #5220 left becomes kubernetes_owned.
func TestApplyClusterEvidenceMakesTheCapturedRunInSync(t *testing.T) {
	plan, schemas := loadDriftFixture(t)
	base := drift.AnalyzeWithSchemas(plan, schemas)
	if base.InSync || base.Drifted != 1 {
		t.Fatalf("fixture baseline: drifted=%d, want 1", base.Drifted)
	}
	f := healthyCluster()
	f.install(t)
	var stdout, stderr bytes.Buffer
	got := applyClusterEvidence(context.Background(), base, plan, schemas, nil,
		ClusterEvidenceReader(awsVC(), "aws", io.Discard), &stdout, &stderr)
	if !got.InSync || got.Normalized != 35 {
		t.Fatalf("drifted=%d normalized=%d, want in sync with 35", got.Drifted, got.Normalized)
	}
	if !strings.Contains(stdout.String(), "1 live TargetGroupBinding") {
		t.Errorf("the evidence count was not logged: %q", stdout.String())
	}
	for _, v := range []string{"sg-0", "8080", "31762", "online-boutique"} {
		if strings.Contains(stdout.String()+stderr.String(), v) {
			t.Errorf("log leaks evidence value %q", v)
		}
	}
}

// TestApplyClusterEvidenceNeverWorsens: no reader, an in-sync posture (the cluster is not even
// read), a read error, and a reader that returns nothing all leave the posture exactly as given.
func TestApplyClusterEvidenceNeverWorsens(t *testing.T) {
	plan, schemas := loadDriftFixture(t)
	base := drift.AnalyzeWithSchemas(plan, schemas)
	if got := applyClusterEvidence(context.Background(), base, plan, schemas, nil, nil, io.Discard, io.Discard); got != base {
		t.Error("no reader: posture replaced")
	}
	inSync := &drift.Posture{InSync: true}
	called := false
	read := func(context.Context, map[string]interface{}) (*drift.ClusterEvidence, error) {
		called = true
		return nil, nil
	}
	if got := applyClusterEvidence(context.Background(), inSync, plan, schemas, nil, read, io.Discard, io.Discard); got != inSync || called {
		t.Error("in sync: the cluster was read or the posture replaced")
	}
	var stderr bytes.Buffer
	failing := func(context.Context, map[string]interface{}) (*drift.ClusterEvidence, error) {
		return nil, errors.New("read targetgroupbindings: forbidden")
	}
	if got := applyClusterEvidence(context.Background(), base, plan, schemas, nil, failing, io.Discard, &stderr); got != base {
		t.Error("read error: posture replaced")
	}
	if !strings.Contains(stderr.String(), "controller-owned rules stay drift") {
		t.Errorf("read error not reported: %q", stderr.String())
	}
	if got := applyClusterEvidence(context.Background(), base, plan, schemas, nil, read, io.Discard, io.Discard); got != base {
		t.Error("nil evidence: posture replaced")
	}
}

// TestClusterOutputsFallback: the configured name fills in only when outputs carry none, and an
// empty configured name adds nothing.
func TestClusterOutputsFallback(t *testing.T) {
	got := clusterOutputs(awsVC(), "aws", map[string]interface{}{"eks_cluster_name": "from-outputs"})
	if got["eks_cluster_name"] != "from-outputs" {
		t.Errorf("outputs overridden: %v", got)
	}
	if got := clusterOutputs(awsVC(), "aws", nil); got["eks_cluster_name"] != fixtureEKS {
		t.Errorf("fallback missing: %v", got)
	}
	if got := clusterOutputs(&types.ProjectConfig{}, "aws", nil); len(got) != 0 {
		t.Errorf("empty name added: %v", got)
	}
}

// TestConfigureClusterKubeconfigUsesTheProvider exercises the real kubeconfig step without a cloud:
// an unknown provider fails, and an outputs-fed kubeconfig (the hetzner shape) is written.
func TestConfigureClusterKubeconfigUsesTheProvider(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("KUBECONFIG", "")
	if err := configureClusterKubeconfig(context.Background(), awsVC(), "nope", nil, io.Discard); err == nil {
		t.Error("unknown provider: want an error")
	}
	outputs := map[string]interface{}{"kubeconfig": "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\n"}
	if err := configureClusterKubeconfig(context.Background(), awsVC(), "hetzner", outputs, io.Discard); err != nil {
		t.Errorf("outputs-fed kubeconfig: %v", err)
	}
}
