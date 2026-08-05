// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	alethiaaws "github.com/alethialabs-io/alethialabs/packages/core/cloud/aws"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"github.com/aws/aws-sdk-go-v2/service/eks"
	ekstypes "github.com/aws/aws-sdk-go-v2/service/eks/types"
)

// fakeDescribeCluster is a DescribeClusterAPI stand-in returning a canned response, so GetContext's
// kubeconfig rendering is exercised without an AWS account.
type fakeDescribeCluster struct {
	out *eks.DescribeClusterOutput
	err error
}

// DescribeCluster returns the canned output/error.
func (f fakeDescribeCluster) DescribeCluster(context.Context, *eks.DescribeClusterInput, ...func(*eks.Options)) (*eks.DescribeClusterOutput, error) {
	return f.out, f.err
}

// strptr is a local pointer helper for the AWS SDK's pointer-heavy shapes.
func strptr(s string) *string { return &s }

// activeCluster is a DescribeCluster response for a cluster whose control plane is ready.
func activeCluster() *eks.DescribeClusterOutput {
	return &eks.DescribeClusterOutput{Cluster: &ekstypes.Cluster{
		Status:               ekstypes.ClusterStatusActive,
		Arn:                  strptr("arn:aws:eks:eu-central-1:123456789012:cluster/demo"),
		Endpoint:             strptr("https://ABC.gr7.eu-central-1.eks.amazonaws.com"),
		CertificateAuthority: &ekstypes.Certificate{Data: strptr("Y2FkYXRh")},
	}}
}

// readKubeconfig finds the single kubeconfig GetContext wrote below root and returns its path+body.
func readKubeconfig(t *testing.T, root string) (string, string) {
	t.Helper()
	var found string
	if err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() && info.Name() == "kubeconfig" {
			found = path
		}
		return nil
	}); err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	if found == "" {
		return "", ""
	}
	data, err := os.ReadFile(found)
	if err != nil {
		t.Fatalf("read kubeconfig: %v", err)
	}
	return found, string(data)
}

// TestGetContextKubeconfig covers the kubeconfig rendering path: a ready cluster writes an
// owner-only file that authenticates through the runner's own kube-token exec plugin (no static
// credential on disk), and a cluster that is not ACTIVE yet is refused without writing anything.
func TestGetContextKubeconfig(t *testing.T) {
	t.Run("active cluster writes an owner-only exec-plugin kubeconfig", func(t *testing.T) {
		tmp := t.TempDir()
		t.Setenv("TMPDIR", tmp)

		cli := &K8sCLI{Region: "eu-central-1", eksClient: fakeDescribeCluster{out: activeCluster()}}
		if err := cli.GetContext("demo", utils.NewLogger(nil, "")); err != nil {
			t.Fatalf("GetContext: %v", err)
		}

		path, body := readKubeconfig(t, tmp)
		if path == "" {
			t.Fatal("GetContext wrote no kubeconfig")
		}
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat kubeconfig: %v", err)
		}
		if got := info.Mode().Perm(); got != 0o600 {
			t.Fatalf("kubeconfig mode = %#o, want 0600 (it names the cluster the runner talks to)", got)
		}
		for _, want := range []string{
			"kube-token",
			"--provider",
			"aws",
			"--cluster",
			"demo",
			"--region",
			"eu-central-1",
			"arn:aws:eks:eu-central-1:123456789012:cluster/demo",
		} {
			if !strings.Contains(body, want) {
				t.Fatalf("kubeconfig missing %q:\n%s", want, body)
			}
		}
		// CLI-free: the aws-iam-authenticator binary is no longer in the image, and a static token
		// must never be persisted — the exec plugin mints one per call.
		if strings.Contains(body, "aws-iam-authenticator") || strings.Contains(body, "token:") {
			t.Fatalf("kubeconfig must carry no static credential and no authenticator binary:\n%s", body)
		}
	})

	t.Run("a cluster that is not ACTIVE is refused, not dereferenced", func(t *testing.T) {
		tmp := t.TempDir()
		t.Setenv("TMPDIR", tmp)

		cli := &K8sCLI{eksClient: fakeDescribeCluster{out: &eks.DescribeClusterOutput{
			Cluster: &ekstypes.Cluster{Status: ekstypes.ClusterStatusCreating},
		}}}
		err := cli.GetContext("demo", utils.NewLogger(nil, ""))
		if !errors.Is(err, alethiaaws.ErrClusterNotReady) {
			t.Fatalf("GetContext error = %v, want ErrClusterNotReady", err)
		}
		if path, _ := readKubeconfig(t, tmp); path != "" {
			t.Fatalf("a not-ready cluster must write no kubeconfig, found %s", path)
		}
	})

	t.Run("a describe failure is propagated", func(t *testing.T) {
		cli := &K8sCLI{eksClient: fakeDescribeCluster{err: errors.New("access denied")}}
		err := cli.GetContext("demo", utils.NewLogger(nil, ""))
		if err == nil || !strings.Contains(err.Error(), "access denied") {
			t.Fatalf("GetContext error = %v, want the describe failure", err)
		}
	})
}

// TestExecSelfPath covers the exec-credential-plugin command resolution: the running binary's own
// absolute path, with a PATH-relative fallback.
func TestExecSelfPath(t *testing.T) {
	got := execSelfPath()
	if got == "" {
		t.Fatal("execSelfPath returned an empty command")
	}
	if self, err := os.Executable(); err == nil && self != "" {
		if got != self {
			t.Fatalf("execSelfPath = %q, want the running binary %q", got, self)
		}
		return
	}
	if got != "runner" {
		t.Fatalf("execSelfPath fallback = %q, want %q", got, "runner")
	}
}

// TestApplyReportsApplyFailure covers the real-apply failure arm: the server-side dry-run passes and
// the apply itself fails, which must surface as an apply error (not a dry-run error).
func TestApplyReportsApplyFailure(t *testing.T) {
	resetK8sSeams(t)
	calls := 0
	executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
		calls++
		if calls == 1 {
			return nil // dry-run succeeds
		}
		return errors.New("the server could not find the requested resource")
	}
	err := (&K8sCLI{}).Apply("prod", "app.yaml", nil, utils.NewLogger(nil, ""))
	if err == nil || !strings.Contains(err.Error(), "kubectl apply failed") {
		t.Fatalf("Apply error = %v, want the apply failure", err)
	}
	if calls != 2 {
		t.Fatalf("executeCommand calls = %d, want dry-run then apply", calls)
	}
}

// TestDecodeStream covers the decoder's tolerant + fail-closed arms: empty and null documents are
// skipped, missing/oddly-typed metadata degrades to empty identity fields, and malformed YAML is an
// error rather than a partial resource list.
func TestDecodeStream(t *testing.T) {
	tests := []struct {
		name      string
		in        string
		wantErr   bool
		wantKinds []string
	}{
		{
			name:      "null and empty documents are skipped",
			in:        "---\n---\nnull\n---\nkind: Service\nmetadata:\n  name: web\n  namespace: apps\n",
			wantKinds: []string{"Service"},
		},
		{
			name:      "a document without metadata still decodes",
			in:        "kind: Namespace\n",
			wantKinds: []string{"Namespace"},
		},
		{
			name:      "non-string kind and metadata degrade to empty identity",
			in:        "kind: 7\nmetadata: notamap\n",
			wantKinds: []string{""},
		},
		{
			name:    "malformed YAML is refused",
			in:      "kind: Service\n  name: [unclosed\n",
			wantErr: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Decode([]byte(tc.in))
			if tc.wantErr {
				if err == nil || !strings.Contains(err.Error(), "invalid k8s YAML") {
					t.Fatalf("Decode error = %v, want an invalid k8s YAML error", err)
				}
				if got != nil {
					t.Fatalf("Decode returned %d resources alongside an error", len(got))
				}
				return
			}
			if err != nil {
				t.Fatalf("Decode: %v", err)
			}
			if len(got) != len(tc.wantKinds) {
				t.Fatalf("Decode returned %d resources, want %d: %#v", len(got), len(tc.wantKinds), got)
			}
			for i, kind := range tc.wantKinds {
				if got[i].Kind != kind {
					t.Fatalf("resource %d kind = %q, want %q", i, got[i].Kind, kind)
				}
			}
		})
	}
}

// TestWorkloadsSkipsUndescribableResources covers the extractor's skip arms: a workload whose pod
// template cannot be located is dropped rather than described as empty, and controller-owned kinds
// are never described at all.
func TestWorkloadsSkipsUndescribableResources(t *testing.T) {
	tests := []struct {
		name string
		in   string
	}{
		{name: "spec is not a map", in: "kind: Deployment\nmetadata:\n  name: a\nspec: nope\n"},
		{name: "no template", in: "kind: Deployment\nmetadata:\n  name: a\nspec:\n  replicas: 1\n"},
		{name: "template has no spec", in: "kind: StatefulSet\nmetadata:\n  name: a\nspec:\n  template:\n    metadata: {}\n"},
		{name: "cronjob without jobTemplate", in: "kind: CronJob\nmetadata:\n  name: a\nspec:\n  schedule: '* * * * *'\n"},
		{name: "cronjob jobTemplate without spec", in: "kind: CronJob\nmetadata:\n  name: a\nspec:\n  jobTemplate:\n    metadata: {}\n"},
		{name: "pod is controller-owned, not described", in: "kind: Pod\nmetadata:\n  name: a\nspec:\n  containers: []\n"},
		{name: "replicaset is controller-owned, not described", in: "kind: ReplicaSet\nmetadata:\n  name: a\nspec:\n  template:\n    spec: {}\n"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res, err := Decode([]byte(tc.in))
			if err != nil {
				t.Fatalf("Decode: %v", err)
			}
			got := Workloads(res)
			if got == nil {
				t.Fatal("Workloads returned nil; it must always return a slice")
			}
			if len(got) != 0 {
				t.Fatalf("Workloads = %#v, want none", got)
			}
		})
	}
}

// TestWorkloadRenderedDetail covers the per-field extraction arms that a well-formed chart never
// reaches: malformed port entries, unnamed/duplicate env, resource selection across containers, and
// the replica rules per workload kind.
func TestWorkloadRenderedDetail(t *testing.T) {
	const manifest = `
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: app
          image: reg/app@sha256:aaa
          ports:
            - "notamap"
            - containerPort: 0
            - containerPort: -1
            - name: http
              containerPort: 8080
              protocol: TCP
          env:
            - "notamap"
            - value: no-name
            - name: DUP
              value: one
            - name: DUP
              value: two
        - name: side
          resources:
            requests:
              cpu: 1
              memory: 128Mi
            limits:
              cpu: 0.5
              memory: 256Mi
---
kind: DaemonSet
metadata:
  name: agent
spec:
  replicas: 4
  template:
    spec:
      containers:
        - name: agent
          image: reg/agent@sha256:bbb
---
kind: StatefulSet
metadata:
  name: db
spec:
  template:
    spec:
      containers:
        - name: db
          image: reg/db@sha256:ccc
          resources:
            requests: {}
`
	res, err := Decode([]byte(manifest))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	got := Workloads(res)
	if len(got) != 3 {
		t.Fatalf("Workloads = %d, want 3: %#v", len(got), got)
	}

	web := got[0].Rendered
	if len(web.Ports) != 1 || web.Ports[0].ContainerPort != 8080 || web.Ports[0].Name != "http" || web.Ports[0].Protocol != "TCP" {
		t.Fatalf("web ports = %#v, want only the one valid containerPort", web.Ports)
	}
	if len(web.EnvKeys) != 1 || web.EnvKeys[0] != "DUP" {
		t.Fatalf("web env keys = %#v, want the de-duplicated named key only", web.EnvKeys)
	}
	if web.Resources == nil {
		t.Fatal("web resources = nil, want the first container that declares any")
	}
	// The first container declares no resources, so the second one's are the description — and a
	// bare `cpu: 1` / `cpu: 0.5` decodes as a number, which must stringify as a k8s quantity.
	if web.Resources.Requests.CPU != "1" || web.Resources.Requests.Memory != "128Mi" {
		t.Fatalf("web requests = %#v", web.Resources.Requests)
	}
	if web.Resources.Limits.CPU != "0.5" || web.Resources.Limits.Memory != "256Mi" {
		t.Fatalf("web limits = %#v", web.Resources.Limits)
	}
	if web.Replicas == nil || *web.Replicas != 3 {
		t.Fatalf("web replicas = %v, want 3", web.Replicas)
	}

	if got[1].Rendered.Replicas != nil {
		t.Fatalf("daemonset replicas = %v, want nil (no replica count)", *got[1].Rendered.Replicas)
	}
	if got[2].Rendered.Replicas != nil {
		t.Fatalf("statefulset replicas = %v, want nil when the manifest omits it", *got[2].Rendered.Replicas)
	}
	// `requests: {}` declares neither cpu nor memory, and an empty map is not "no resources" — the
	// container declared the key, so it is the described one, with empty quantities.
	if got[2].Rendered.Resources == nil {
		t.Fatal("statefulset resources = nil, want the declared (empty) requests")
	}
	if got[2].Rendered.Resources.Limits.CPU != "" {
		t.Fatalf("statefulset limits = %#v, want empty", got[2].Rendered.Resources.Limits)
	}
	if got[2].Rendered.Image != "reg/db@sha256:ccc" {
		t.Fatalf("statefulset image = %q", got[2].Rendered.Image)
	}
}

// TestWorkloadNumericAndEmptyEdges covers the numeric-coercion arms a hand-written chart can still
// produce: a float-typed port, a negative replica count (which describes nothing rather than a
// negative number), and a pod whose only containers are init containers.
func TestWorkloadNumericAndEmptyEdges(t *testing.T) {
	res, err := Decode([]byte(`
kind: Deployment
metadata:
  name: floaty
spec:
  replicas: 2.0
  template:
    spec:
      containers:
        - name: app
          image: reg/app@sha256:aaa
          ports:
            - containerPort: 8080.0
---
kind: Deployment
metadata:
  name: negative
spec:
  replicas: -1
  template:
    spec:
      containers:
        - name: app
          image: reg/app@sha256:bbb
---
kind: Job
metadata:
  name: initonly
spec:
  template:
    spec:
      initContainers:
        - name: setup
          image: reg/setup@sha256:ccc
`))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	got := Workloads(res)
	if len(got) != 3 {
		t.Fatalf("Workloads = %d, want 3", len(got))
	}
	if len(got[0].Rendered.Ports) != 1 || got[0].Rendered.Ports[0].ContainerPort != 8080 {
		t.Fatalf("float containerPort = %#v, want 8080", got[0].Rendered.Ports)
	}
	if got[0].Rendered.Replicas == nil || *got[0].Rendered.Replicas != 2 {
		t.Fatalf("float replicas = %v, want 2", got[0].Rendered.Replicas)
	}
	if got[1].Rendered.Replicas != nil {
		t.Fatalf("negative replicas = %v, want nil", *got[1].Rendered.Replicas)
	}
	// Only the primary containers describe a workload — an init-only pod has no image to report.
	if got[2].Rendered.Image != "" {
		t.Fatalf("init-only image = %q, want empty", got[2].Rendered.Image)
	}
	if got[2].Rendered.Resources != nil {
		t.Fatalf("init-only resources = %#v, want nil", got[2].Rendered.Resources)
	}
}

// TestWorkloadKindMapping covers the kind allow-list, including the controller-owned kinds that are
// deliberately not described.
func TestWorkloadKindMapping(t *testing.T) {
	tests := []struct {
		kind     string
		want     string
		wantOK   bool
		describe string
	}{
		{kind: "Deployment", want: "deployment", wantOK: true},
		{kind: "StatefulSet", want: "statefulset", wantOK: true},
		{kind: "DaemonSet", want: "daemonset", wantOK: true},
		{kind: "CronJob", want: "cronjob", wantOK: true},
		{kind: "Job", want: "job", wantOK: true},
		{kind: "Pod"},
		{kind: "ReplicaSet"},
		{kind: "ReplicationController"},
		{kind: "Service"},
		{kind: ""},
	}
	for _, tc := range tests {
		t.Run(tc.kind, func(t *testing.T) {
			got, ok := workloadKind(tc.kind)
			if ok != tc.wantOK || got != tc.want {
				t.Fatalf("workloadKind(%q) = (%q, %v), want (%q, %v)", tc.kind, got, ok, tc.want, tc.wantOK)
			}
		})
	}
}

// TestCronJobPodTemplateIsFound covers the CronJob's deeper pod-template path end to end.
func TestCronJobPodTemplateIsFound(t *testing.T) {
	res, err := Decode([]byte(`
kind: CronJob
metadata:
  name: sweeper
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: sweep
              image: reg/sweep@sha256:ddd
`))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	got := Workloads(res)
	if len(got) != 1 || got[0].Rendered.Image != "reg/sweep@sha256:ddd" {
		t.Fatalf("Workloads = %#v", got)
	}
	if got[0].Rendered.Replicas != nil {
		t.Fatalf("cronjob replicas = %v, want nil", *got[0].Rendered.Replicas)
	}
	if got[0].Rendered.Ports == nil || len(got[0].Rendered.Ports) != 0 {
		t.Fatalf("cronjob ports = %#v, want an empty (never nil) slice", got[0].Rendered.Ports)
	}
}

// TestWaitClusterReadyNonAuthFailureAndCancel covers the two probe-loop arms a passing cluster never
// reaches: a non-auth failure (which resets the consecutive-auth-rejection counter and is classified
// as a network verdict) and a caller who cancels the context.
func TestWaitClusterReadyNonAuthFailureAndCancel(t *testing.T) {
	resetK8sSeams(t)

	t.Run("a network failure is classified, not treated as an auth rejection", func(t *testing.T) {
		executeCommandWithOutput = func(string, string, []string) (string, error) {
			return "", errors.New("dial tcp 10.0.0.1:443: i/o timeout")
		}
		err := WaitClusterReady(context.Background(), 0, false, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "NETWORK UNREACHABLE") {
			t.Fatalf("WaitClusterReady error = %v, want a network verdict", err)
		}
		if strings.Contains(err.Error(), "auth rejected") {
			t.Fatalf("a network failure must not fast-fail as an auth rejection: %v", err)
		}
	})

	t.Run("a cancelled context ends the wait instead of burning the budget", func(t *testing.T) {
		executeCommandWithOutput = func(string, string, []string) (string, error) {
			return "", errors.New("connection refused")
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		done := make(chan error, 1)
		go func() { done <- WaitClusterReady(ctx, time.Hour, false, io.Discard) }()
		select {
		case err := <-done:
			if err == nil {
				t.Fatal("WaitClusterReady returned nil for a cancelled wait")
			}
		case <-time.After(5 * time.Second):
			t.Fatal("WaitClusterReady kept polling after its context was cancelled")
		}
	})
}

// TestWaitClusterReadyNodePollFailures covers the node-poll arms where kubectl fails outright or
// returns output that is not parseable node JSON — neither may count as a Ready node.
func TestWaitClusterReadyNodePollFailures(t *testing.T) {
	resetK8sSeams(t)

	tests := []struct {
		name  string
		nodes string
		err   error
	}{
		{name: "kubectl get nodes fails", err: errors.New("error: You must be logged in")},
		{name: "node output is not json", nodes: "NAME STATUS\nnode-1 Ready"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			executeCommandWithOutput = func(command, _ string, _ []string) (string, error) {
				if command == "kubectl get --raw=/readyz" {
					return "ok", nil
				}
				return tc.nodes, tc.err
			}
			err := WaitClusterReady(context.Background(), 0, true, io.Discard)
			if err == nil || !strings.Contains(err.Error(), "no cluster node reached Ready") {
				t.Fatalf("WaitClusterReady error = %v, want the node timeout", err)
			}
			if !strings.Contains(err.Error(), "(0/0 ready)") {
				t.Fatalf("unparseable node state must count as 0/0, got: %v", err)
			}
		})
	}
}

// TestNotReadyReasons covers the reason/message composition arms, including a node that reports
// neither, which must still name its Ready status rather than produce an empty entry.
func TestNotReadyReasonsComposition(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want []string
	}{
		{
			name: "reason and message are joined",
			raw:  `{"items":[{"status":{"conditions":[{"type":"Ready","status":"False","reason":"KubeletNotReady","message":"cni not ready"}]}}]}`,
			want: []string{"KubeletNotReady: cni not ready"},
		},
		{
			name: "message only",
			raw:  `{"items":[{"status":{"conditions":[{"type":"Ready","status":"False","message":"kubelet stopped posting"}]}}]}`,
			want: []string{"kubelet stopped posting"},
		},
		{
			name: "neither reason nor message names the status",
			raw:  `{"items":[{"status":{"conditions":[{"type":"Ready","status":"Unknown"}]}}]}`,
			want: []string{"Ready=Unknown"},
		},
		{
			name: "identical reasons are de-duplicated across nodes",
			raw: `{"items":[` +
				`{"status":{"conditions":[{"type":"Ready","status":"False","reason":"KubeletNotReady"}]}},` +
				`{"status":{"conditions":[{"type":"Ready","status":"False","reason":"KubeletNotReady"}]}}]}`,
			want: []string{"KubeletNotReady"},
		},
		{
			name: "ready nodes contribute nothing",
			raw:  `{"items":[{"status":{"conditions":[{"type":"Ready","status":"True"}]}}]}`,
		},
		{
			name: "unparseable json yields nothing",
			raw:  `not json`,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := NotReadyReasons([]byte(tc.raw))
			if len(got) != len(tc.want) {
				t.Fatalf("NotReadyReasons = %#v, want %#v", got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Fatalf("NotReadyReasons[%d] = %q, want %q", i, got[i], tc.want[i])
				}
			}
		})
	}
}

// TestWaitPodToAPIServerApplyFailure covers the arm where the probe Job cannot be created at all —
// which must be reported as a probe-creation failure, not as a pod-network verdict.
func TestWaitPodToAPIServerApplyFailure(t *testing.T) {
	resetK8sSeams(t)
	executeCommandWithOutput = func(command, _ string, _ []string) (string, error) {
		switch {
		case strings.Contains(command, "jsonpath={.spec.clusterIP}"):
			return "10.96.0.1", nil
		case strings.HasPrefix(command, "kubectl apply -f "):
			return "", errors.New("admission webhook denied the request")
		default:
			return "", nil
		}
	}
	err := WaitPodToAPIServer(context.Background(), time.Second, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "failed to create the in-cluster pod->apiserver probe Job") {
		t.Fatalf("WaitPodToAPIServer error = %v, want the Job-creation failure", err)
	}
	if strings.Contains(err.Error(), "pod network is broken") {
		t.Fatalf("a Job that never applied must not read as a network verdict: %v", err)
	}
}

// TestWaitPodToAPIServerSkip covers the documented opt-out.
func TestWaitPodToAPIServerSkipVariants(t *testing.T) {
	resetK8sSeams(t)
	executeCommandWithOutput = func(command, _ string, _ []string) (string, error) {
		t.Fatalf("no command may run when the probe is skipped, got %q", command)
		return "", nil
	}
	for _, v := range []string{"1", "true", "TRUE"} {
		t.Setenv("ALETHIA_CLUSTER_SKIP_INCLUSTER_PROBE", v)
		if err := WaitPodToAPIServer(context.Background(), time.Second, io.Discard); err != nil {
			t.Fatalf("WaitPodToAPIServer(%q): %v", v, err)
		}
	}
}

// TestPodProbeVerdictPhaseless covers the verdict for a pod observed only through its container's
// waiting reason — the phase is unknown, so the reason alone must carry the diagnosis.
func TestPodProbeVerdictPhaseless(t *testing.T) {
	tests := []struct {
		name    string
		phase   string
		waiting string
		want    string
	}{
		{name: "waiting reason only", waiting: "ImagePullBackOff", want: "the probe pod never started (ImagePullBackOff)"},
		{name: "nothing observed", want: "the probe pod never started (no pod observed)"},
		{name: "phase and reason", phase: "Pending", waiting: "Unschedulable", want: "the probe pod never started (Pending/Unschedulable)"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := podProbeVerdict(tc.phase, tc.waiting)
			if !strings.HasPrefix(got, tc.want) {
				t.Fatalf("podProbeVerdict(%q, %q) = %q, want prefix %q", tc.phase, tc.waiting, got, tc.want)
			}
			if strings.Contains(got, "pod network is broken") {
				t.Fatalf("a pod that never started must not get the network verdict: %q", got)
			}
		})
	}
}

// TestPodStallVerdictFallback covers the fallback arm of the post-mortem verdict: a state nobody
// enumerated must still be reported rather than silently reading as healthy.
func TestPodStallVerdictFallback(t *testing.T) {
	tests := []struct {
		name    string
		phase   string
		ready   string
		waiting string
		want    string
	}{
		{name: "unenumerated reason with no phase", waiting: "OOMKilled", want: "not running (OOMKilled)"},
		{name: "unenumerated phase and reason", phase: "Failed", waiting: "DeadlineExceeded", want: "not running (Failed/DeadlineExceeded)"},
		{name: "no state at all", want: "not running (no state reported)"},
		{name: "failed with no reason", phase: "Failed", want: "not running (Failed)"},
		{name: "succeeded is not a stall", phase: "Succeeded", ready: "true"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := podStallVerdict(tc.phase, tc.ready, tc.waiting); got != tc.want {
				t.Fatalf("podStallVerdict(%q, %q, %q) = %q, want %q", tc.phase, tc.ready, tc.waiting, got, tc.want)
			}
		})
	}
}

// TestCollectOutReportsAFailedDiagnostic covers the best-effort diagnostic collector: a kubectl that
// fails must still say so, because an empty section reads as an empty cluster.
func TestCollectOutReportsAFailedDiagnostic(t *testing.T) {
	resetK8sSeams(t)
	executeCommandWithOutput = func(string, string, []string) (string, error) {
		return "", errors.New("kubectl: command not found")
	}
	got := collectOut("kubectl get pods")
	if !strings.HasPrefix(got, "command failed: ") || !strings.Contains(got, "command not found") {
		t.Fatalf("collectOut = %q, want the failure text", got)
	}
}
