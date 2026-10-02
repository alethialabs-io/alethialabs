// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// FREE, every-PR proof of the aws capacity-type decision (#5316) — NO build tag, NO cloud.
//
// #5266 moved the aws node group's template default from SPOT to ON_DEMAND. Every aws e2e shape now
// pins `capacity_type: spot`, except ONE cell held on the default so the default path stays proven:
// the dimension the workflow names in AWS_DEFAULT_CAPACITY_DIMENSION, with no fabric-demo rider.
//
// WHAT IS RUN, AND WHY IT IS RUN RATHER THAN READ. The shape is decided by the `Compute cluster
// shape` step's shell — a case arm, a jq deletion keyed on the dimension, then the heavy / demo
// fixture overrides. A test that pattern-matched the literal would agree with a script whose
// deletion fired on the wrong dimension, or whose fixture branch replaced the pin. So this test
// extracts that step's `run:` text from the workflow and EXECUTES it, per dimension, exactly as the
// runner would, then carries the result down the seeded route the nightly takes:
//
//	ALETHIA_E2E_CLUSTER_JSON → t2MergeClusterJSON → snapshot JSON → types.ProjectConfig
//	                         → awsProvider.ProviderTfvars → eks_ng_capacity_type
//
// and, for cli-demo, down the CLI route (CLIDemoClusterSets → `--set capacity_type=spot`).
package e2e

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	corecloud "github.com/alethialabs-io/alethialabs/packages/core/cloud"
	coretypes "github.com/alethialabs-io/alethialabs/packages/core/types"
	"gopkg.in/yaml.v3"
)

// awsShapeStep is the name of the workflow step whose run script decides the cluster shape.
const awsShapeStep = "Compute cluster shape"

// shapeStepScript returns the `run:` text of the workflow's cluster-shape step. It fails when the
// step is missing or appears twice, because either means this test has lost its subject.
func shapeStepScript(t *testing.T) string {
	t.Helper()
	path := filepath.Join(repoRootForTest(t), ".github", "workflows", "e2e-nightly.yml")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var wf struct {
		Jobs map[string]struct {
			Steps []struct {
				Name string `yaml:"name"`
				Run  string `yaml:"run"`
			} `yaml:"steps"`
		} `yaml:"jobs"`
	}
	if err := yaml.Unmarshal(raw, &wf); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	var found []string
	for _, job := range wf.Jobs {
		for _, s := range job.Steps {
			if s.Name == awsShapeStep {
				found = append(found, s.Run)
			}
		}
	}
	if len(found) != 1 {
		t.Fatalf("want exactly one %q step in %s, found %d — repoint this test, do not delete it", awsShapeStep, path, len(found))
	}
	if strings.Contains(found[0], "${{") {
		t.Fatalf("the %q script now carries a ${{ }} expression, which this test cannot evaluate offline", awsShapeStep)
	}
	return found[0]
}

// resolveDimension runs scripts/e2e/resolve-dimension.sh with the given arguments.
func resolveDimension(t *testing.T, args ...string) string {
	t.Helper()
	cmd := exec.Command("bash", append([]string{filepath.Join(repoRootForTest(t), "scripts", "e2e", "resolve-dimension.sh")}, args...)...)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("resolve-dimension.sh %v: %v", args, err)
	}
	return strings.TrimSpace(string(out))
}

// awsDimensions lists every dimension an aws leg may run, from the resolver's own vocabulary.
func awsDimensions(t *testing.T) []string {
	t.Helper()
	var dims []string
	for _, d := range strings.Fields(resolveDimension(t, "--dimensions")) {
		providers := strings.Fields(resolveDimension(t, "--providers", d))
		if len(providers) == 0 || strings.Contains(" "+strings.Join(providers, " ")+" ", " aws ") {
			dims = append(dims, d)
		}
	}
	if len(dims) < 2 {
		t.Fatalf("the resolver yielded %d aws dimensions (%v) — the sweep would prove nothing", len(dims), dims)
	}
	return dims
}

// runShapeStep executes the shape step's script for aws on one dimension and returns the
// ALETHIA_E2E_CLUSTER_JSON it wrote to $GITHUB_ENV ("" when it wrote none).
func runShapeStep(t *testing.T, script, dimension string, fabricDemo bool) string {
	t.Helper()
	if _, err := exec.LookPath("jq"); err != nil {
		t.Fatalf("jq is not on PATH — the shape step needs it on the runner, and so does this test: %v", err)
	}
	ghEnv := filepath.Join(t.TempDir(), "github_env")
	demo := ""
	if fabricDemo {
		demo = "1"
	}
	// `bash -e`, as GitHub runs a `run:` block.
	cmd := exec.Command("bash", "-e", "-c", script)
	cmd.Dir = repoRootForTest(t)
	cmd.Env = append(os.Environ(),
		"PROVIDER=aws",
		"E2E_DIMENSION="+dimension,
		"E2E_HEAVY_SHAPE="+resolveDimension(t, "--heavy", dimension),
		"E2E_FABRIC_DEMO="+demo,
		"GITHUB_ENV="+ghEnv,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("the %q step failed for aws/%s (demo=%v): %v\n%s", awsShapeStep, dimension, fabricDemo, err, out)
	}
	written, err := os.ReadFile(ghEnv)
	if err != nil && !os.IsNotExist(err) {
		t.Fatalf("read $GITHUB_ENV: %v", err)
	}
	for _, line := range strings.Split(string(written), "\n") {
		if v, ok := strings.CutPrefix(line, "ALETHIA_E2E_CLUSTER_JSON="); ok {
			return v
		}
	}
	return ""
}

// awsCapacityTfvar carries one cluster JSON down the seeded route and returns the tfvar it becomes.
// present=false means the tfvar is absent, so the template default (ON_DEMAND) decides.
func awsCapacityTfvar(t *testing.T, clusterJSON string) (value any, present bool) {
	t.Helper()
	snapshot := map[string]any{
		"id": "e2e-audit", "project_name": "capacity", "environment_stage": "dev",
		"provider": "aws", "region": "us-east-1", "addons": []any{},
	}
	t.Setenv("ALETHIA_E2E_CLUSTER_JSON", clusterJSON)
	if err := t2MergeClusterJSON(snapshot); err != nil {
		t.Fatalf("merge cluster JSON: %v", err)
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	var pc coretypes.ProjectConfig
	if err := json.Unmarshal(encoded, &pc); err != nil {
		t.Fatalf("decode snapshot into ProjectConfig: %v", err)
	}
	cp, err := corecloud.NewCloudProvider("aws")
	if err != nil {
		t.Fatalf("aws provider: %v", err)
	}
	value, present = cp.ProviderTfvars(&pc)["eks_ng_capacity_type"]
	return value, present
}

// TestAWSShapesPinSpotExceptTheDefaultCell runs the workflow's shape step for every aws dimension,
// with and without the fabric-demo rider, and holds each result to the decision: exactly the floor
// cell (no rider) reaches the template with no capacity type; every other cell reaches it as SPOT.
func TestAWSShapesPinSpotExceptTheDefaultCell(t *testing.T) {
	script := shapeStepScript(t)
	const defaultCell = "floor"
	if !strings.Contains(script, "AWS_DEFAULT_CAPACITY_DIMENSION="+defaultCell+"\n") {
		t.Fatalf("the workflow no longer names %q as the aws default-capacity cell; update this test and the spend guard's R5 together", defaultCell)
	}
	defaults := 0
	for _, dim := range awsDimensions(t) {
		for _, demo := range []bool{false, true} {
			name := "aws/" + dim
			if demo {
				name += "+fabric-demo"
			}
			t.Run(name, func(t *testing.T) {
				shape := runShapeStep(t, script, dim, demo)
				if shape == "" {
					t.Fatalf("no ALETHIA_E2E_CLUSTER_JSON for %s — the harness cost guard would refuse the run", name)
				}
				value, present := awsCapacityTfvar(t, shape)
				if dim == defaultCell && !demo {
					defaults++
					if strings.Contains(shape, "capacity_type") || present {
						t.Errorf("%s is the default-capacity cell: its shape must carry no capacity_type and the "+
							"tfvar must be absent so the template default decides; shape=%s tfvar=%v", name, shape, value)
					}
					return
				}
				if value != "SPOT" {
					t.Errorf("%s must reach the template as eks_ng_capacity_type=SPOT, got %v (present=%v)\nshape: %s",
						name, value, present, shape)
				}
			})
		}
	}
	if defaults != 1 {
		t.Errorf("exactly ONE aws cell must stay on the default capacity type, found %d", defaults)
	}
}

// TestAWSCLIDemoShapeCarriesSpotAsASetPair: the cli-demo leg has no snapshot to merge into — the CLI
// authors the project — so the pin must survive the translation into `--set` pairs.
func TestAWSCLIDemoShapeCarriesSpotAsASetPair(t *testing.T) {
	shape := runShapeStep(t, shapeStepScript(t), "cli-demo", false)
	t.Setenv("ALETHIA_E2E_CLUSTER_JSON", shape)
	got := strings.Join(CLIDemoClusterSets(t), " ")
	if !strings.Contains(got, "--set capacity_type=spot") {
		t.Errorf("the aws cli-demo shape lost its spot pin on the way to the CLI:\n%s", got)
	}
}
