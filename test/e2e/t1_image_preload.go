// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// T1's ArgoCD images reach the kind node from the RUNNER's docker cache, not from a registry (#6044).
//
// The runner (provisioner.installArgoCD) installs the argo-cd chart into the kind cluster T1 boots,
// and the kubelet inside that cluster used to pull every image itself. One of them is the chart's
// default redis, `ecr-public.aws.com/docker/library/redis:…`, and ECR Public rate-limits anonymous
// pulls per source IP. GitHub's runners share IPs, so overlapping T1 runs got `toomanyrequests`,
// redis sat in ImagePullBackOff, `helm --wait` expired and the queue batch went red.
//
// The fix has three parts, in three places:
//
//  1. cmd/argoimages renders the chart at the version the runner installs (ArgoChartImages) and
//     prints every image it names. The list is DERIVED, so a chart bump that adds or moves an
//     image changes the list with it; there is no hand-written copy to drift.
//  2. ci.yml's provision-e2e job pulls that list into the runner's docker with
//     scripts/ci/docker-pull-retry.sh, which retries only a rate limit or a transport error.
//  3. The T1 test loads the pulled images into the kind cluster as soon as its nodes exist
//     (PreloadIntoKind). The cluster is created by the runner's `tofu apply`, inside the test, so
//     there is no earlier point at which a workflow step could load them.
//
// Part 3 races the runner, and that is safe in both orders. No container the chart renders is
// pulled when its node already holds the image (PreloadImageList refuses the list otherwise; at
// 9.5.11 every one is IfNotPresent), so a pod scheduled after the load never pulls, and a pod whose
// pull failed before the load finds the image on its next back-off retry.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"gopkg.in/yaml.v3"
)

// T1PreloadImagesEnv names the file, one image per line, that the workflow pulled for T1 to load.
const T1PreloadImagesEnv = "ALETHIA_E2E_T1_PRELOAD_IMAGES"

// ChartImage is one container image a rendered chart names, with the pull policy and the place it
// came from (kind/name/container), so a refusal can say which workload it is about.
type ChartImage struct {
	Image      string
	PullPolicy string
	Where      string
}

// containerListKeys are the pod-spec fields that hold containers with an `image`.
var containerListKeys = []string{"initContainers", "containers", "ephemeralContainers"}

// ParseChartImages reads `helm template` output and returns every container image in it, in
// document order. It walks each document generically rather than per kind, so a Deployment, a
// StatefulSet, a Job hook and a CronJob are all read by the same code.
func ParseChartImages(rendered []byte) ([]ChartImage, error) {
	dec := yaml.NewDecoder(bytes.NewReader(rendered))
	var out []ChartImage
	for {
		var doc map[string]interface{}
		err := dec.Decode(&doc)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("parse rendered chart: %w", err)
		}
		if doc == nil {
			continue
		}
		kind, _ := doc["kind"].(string)
		name := ""
		if md, ok := doc["metadata"].(map[string]interface{}); ok {
			name, _ = md["name"].(string)
		}
		out = append(out, collectContainerImages(doc, kind+"/"+name)...)
	}
	return out, nil
}

// collectContainerImages walks one decoded YAML node and returns the image of every container found
// under a containerListKeys field, at any depth.
func collectContainerImages(node interface{}, where string) []ChartImage {
	var out []ChartImage
	switch n := node.(type) {
	case map[string]interface{}:
		for _, key := range containerListKeys {
			list, ok := n[key].([]interface{})
			if !ok {
				continue
			}
			for _, item := range list {
				c, ok := item.(map[string]interface{})
				if !ok {
					continue
				}
				img, _ := c["image"].(string)
				if img == "" {
					continue
				}
				policy, _ := c["imagePullPolicy"].(string)
				cname, _ := c["name"].(string)
				out = append(out, ChartImage{Image: img, PullPolicy: policy, Where: where + "/" + cname})
			}
		}
		keys := make([]string, 0, len(n))
		for k := range n {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			out = append(out, collectContainerImages(n[k], where)...)
		}
	case []interface{}:
		for _, item := range n {
			out = append(out, collectContainerImages(item, where)...)
		}
	}
	return out
}

// imageTag returns the tag of an image reference ("" when it has none), ignoring a registry port
// and treating a digest-pinned reference as tagged.
func imageTag(ref string) (tag string, digest bool) {
	if strings.Contains(ref, "@") {
		return "", true
	}
	last := ref[strings.LastIndex(ref, "/")+1:]
	if i := strings.LastIndex(last, ":"); i >= 0 {
		return last[i+1:], false
	}
	return "", false
}

// PreloadImageList turns a chart's images into the sorted, de-duplicated list T1 pre-loads. It
// refuses any image the kubelet would pull even when the node already holds it: an explicit
// `Always`, or no policy on an untagged or `:latest` reference, which Kubernetes defaults to Always.
// A pre-load the kubelet ignores would be a step that reports success and changes nothing. It also
// refuses an empty list, which would mean the render or the parse found no workloads at all.
func PreloadImageList(imgs []ChartImage) ([]string, error) {
	var refusals []string
	seen := map[string]bool{}
	var out []string
	for _, ci := range imgs {
		tag, digest := imageTag(ci.Image)
		switch {
		case ci.PullPolicy == "Always":
			refusals = append(refusals, fmt.Sprintf("%s (%s) has imagePullPolicy Always", ci.Image, ci.Where))
		case ci.PullPolicy == "" && !digest && (tag == "" || tag == "latest"):
			refusals = append(refusals, fmt.Sprintf("%s (%s) has no pull policy and an untagged or :latest reference, which defaults to Always", ci.Image, ci.Where))
		}
		if !seen[ci.Image] {
			seen[ci.Image] = true
			out = append(out, ci.Image)
		}
	}
	if len(refusals) > 0 {
		return nil, fmt.Errorf("the kubelet would pull these even after a pre-load:\n  %s", strings.Join(refusals, "\n  "))
	}
	if len(out) == 0 {
		return nil, errors.New("the rendered chart names no container images — the render or the parse is broken")
	}
	sort.Strings(out)
	return out, nil
}

// ArgoChartTemplateArgs is the `helm template` argv that renders the argo-cd chart the way the
// runner installs it on every cluster: the same repository and version resolvers, the one `--set`
// and the two values files it always passes (valuesDir holds them; see WriteArgoInstallValues). The
// ingress `--set`s it adds when DNS is enabled change no image, and T1's project has no DNS.
func ArgoChartTemplateArgs(valuesDir string) []string {
	return []string{
		"template", "argo-cd", "argo-cd",
		"--repo", argocd.ResolvedArgoHelmRepo(),
		"--version", argocd.ResolvedArgoChartVersion(),
		"--namespace", "argocd",
		"--set", "redisSecretInit.enabled=false",
		"-f", filepath.Join(valuesDir, "argocd-probes.yaml"),
		"-f", filepath.Join(valuesDir, "argocd-resources.yaml"),
	}
}

// WriteArgoInstallValues writes the two values files provisioner.installArgoCD passes on every
// install into dir, under the names ArgoChartTemplateArgs reads.
func WriteArgoInstallValues(dir string) error {
	if err := os.WriteFile(filepath.Join(dir, "argocd-probes.yaml"), []byte(argocd.InstallProbeValues()), 0o600); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "argocd-resources.yaml"), []byte(argocd.InstallResourceValues()), 0o600)
}

// ArgoChartImages renders the pinned argo-cd chart with helm and returns the images T1 must
// pre-load. It needs helm on PATH and network access to the chart repository.
func ArgoChartImages(ctx context.Context) ([]string, error) {
	dir, err := os.MkdirTemp("", "argoimages-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	if err := WriteArgoInstallValues(dir); err != nil {
		return nil, fmt.Errorf("write the runner's argo-cd values: %w", err)
	}
	var stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, "helm", ArgoChartTemplateArgs(dir)...)
	cmd.Stderr = &stderr
	rendered, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("helm template argo-cd %s: %w: %s", argocd.ResolvedArgoChartVersion(), err, strings.TrimSpace(stderr.String()))
	}
	imgs, err := ParseChartImages(rendered)
	if err != nil {
		return nil, err
	}
	return PreloadImageList(imgs)
}

// ReadImageList reads a file of one image per line, ignoring blank lines and `#` comments. An empty
// list is an error: a pre-load of nothing would pass while loading nothing.
func ReadImageList(path string) ([]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		out = append(out, line)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%s lists no images", path)
	}
	return out, nil
}

// KindRunner runs `kind` with args and returns its combined output.
type KindRunner func(ctx context.Context, args ...string) (string, error)

// ExecKind is the KindRunner that runs the real kind binary.
func ExecKind(ctx context.Context, args ...string) (string, error) {
	out, err := exec.CommandContext(ctx, "kind", args...).CombinedOutput()
	return string(out), err
}

// kindNoNodesMarker is what `kind load` prints while the cluster's node containers do not exist yet.
const kindNoNodesMarker = "no nodes found for cluster"

// PreloadOptions bounds PreloadIntoKind.
type PreloadOptions struct {
	// Poll is the wait between attempts, both while the cluster does not exist and after a failure.
	Poll time.Duration
	// MaxFailures is how many failed loads ON AN EXISTING CLUSTER are tolerated before giving up.
	MaxFailures int
}

// PreloadIntoKind waits for the kind cluster `cluster` to have nodes, then runs `kind load
// docker-image` for images. Until the nodes exist, kind's "no nodes found" answer is the expected
// waiting state and is not counted. Any other failure is logged and retried, up to MaxFailures; a
// load that succeeds after a failure logs that it retried. It returns an error if ctx ends first or
// the failures run out.
func PreloadIntoKind(ctx context.Context, cluster string, images []string, run KindRunner, opt PreloadOptions, logf func(string, ...interface{})) error {
	if len(images) == 0 {
		return errors.New("no images to pre-load")
	}
	args := append([]string{"load", "docker-image", "--name", cluster}, images...)
	failures := 0
	waited := false
	for {
		out, err := run(ctx, args...)
		if err == nil {
			if failures > 0 {
				logf("pre-load into kind %s succeeded after %d failed attempt(s) — retried, see above", cluster, failures)
			} else {
				logf("pre-loaded %d image(s) into kind %s", len(images), cluster)
			}
			return nil
		}
		out = strings.TrimSpace(out)
		if strings.Contains(out, kindNoNodesMarker) {
			if !waited {
				logf("pre-load: kind cluster %s has no nodes yet — waiting for the runner to create it", cluster)
				waited = true
			}
		} else {
			failures++
			logf("pre-load into kind %s: attempt failed (%d/%d): %v: %s", cluster, failures, opt.MaxFailures, err, out)
			if failures >= opt.MaxFailures {
				return fmt.Errorf("kind load docker-image into %s failed %d times; last: %v: %s", cluster, failures, err, out)
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("pre-load into kind %s did not complete: %w", cluster, ctx.Err())
		case <-time.After(opt.Poll):
		}
	}
}
