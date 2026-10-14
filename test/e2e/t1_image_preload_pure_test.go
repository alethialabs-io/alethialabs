// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
)

// renderedFixture is the shape `helm template` emits for the argo-cd chart: a Deployment with an
// init container, a StatefulSet, a hook Job, a CronJob nested one level deeper, a non-workload
// document and an empty document between separators.
const renderedFixture = `---
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
data:
  image: not-a-container-image
---
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: argocd-server
spec:
  template:
    spec:
      initContainers:
        - name: copyutil
          image: quay.io/argoproj/argocd:v3.3.9
          imagePullPolicy: IfNotPresent
      containers:
        - name: server
          image: quay.io/argoproj/argocd:v3.3.9
          imagePullPolicy: IfNotPresent
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: argocd-redis
spec:
  template:
    spec:
      containers:
        - name: redis
          image: ecr-public.aws.com/docker/library/redis:8.2.3-alpine
          imagePullPolicy: IfNotPresent
---
apiVersion: batch/v1
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
              image: ghcr.io/dexidp/dex:v2.45.1
`

func TestParseChartImagesFindsEveryContainerAtAnyDepth(t *testing.T) {
	imgs, err := ParseChartImages([]byte(renderedFixture))
	if err != nil {
		t.Fatal(err)
	}
	got := make([]string, 0, len(imgs))
	for _, ci := range imgs {
		got = append(got, ci.Where+"="+ci.Image+"@"+ci.PullPolicy)
	}
	want := []string{
		"Deployment/argocd-server/copyutil=quay.io/argoproj/argocd:v3.3.9@IfNotPresent",
		"Deployment/argocd-server/server=quay.io/argoproj/argocd:v3.3.9@IfNotPresent",
		"Deployment/argocd-redis/redis=ecr-public.aws.com/docker/library/redis:8.2.3-alpine@IfNotPresent",
		"CronJob/sweeper/sweep=ghcr.io/dexidp/dex:v2.45.1@",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
}

func TestParseChartImagesRejectsMalformedYAML(t *testing.T) {
	if _, err := ParseChartImages([]byte("kind: [unclosed\n")); err == nil {
		t.Fatal("malformed YAML parsed without error")
	}
}

func TestPreloadImageListDedupesAndSorts(t *testing.T) {
	imgs, err := ParseChartImages([]byte(renderedFixture))
	if err != nil {
		t.Fatal(err)
	}
	got, err := PreloadImageList(imgs)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"ecr-public.aws.com/docker/library/redis:8.2.3-alpine",
		"ghcr.io/dexidp/dex:v2.45.1",
		"quay.io/argoproj/argocd:v3.3.9",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// Each of these would make the kubelet pull an image the node already holds, so the pre-load would
// report success and change nothing.
func TestPreloadImageListRefusesWhatTheKubeletWouldPullAnyway(t *testing.T) {
	for _, tc := range []ChartImage{
		{Image: "quay.io/argoproj/argocd:v3.3.9", PullPolicy: "Always", Where: "Deployment/a/b"},
		{Image: "redis", Where: "Deployment/a/b"},
		{Image: "redis:latest", Where: "Deployment/a/b"},
		{Image: "registry.local:5000/redis", Where: "Deployment/a/b"},
	} {
		if _, err := PreloadImageList([]ChartImage{tc}); err == nil || !strings.Contains(err.Error(), tc.Image) {
			t.Errorf("%+v: err = %v, want a refusal naming the image", tc, err)
		}
	}
}

func TestPreloadImageListAcceptsDigestsAndExplicitIfNotPresent(t *testing.T) {
	for _, tc := range []ChartImage{
		{Image: "redis@sha256:abc"},
		{Image: "registry.local:5000/redis:8.2"},
		{Image: "redis:latest", PullPolicy: "IfNotPresent"},
		{Image: "redis", PullPolicy: "Never"},
	} {
		if _, err := PreloadImageList([]ChartImage{tc}); err != nil {
			t.Errorf("%+v refused: %v", tc, err)
		}
	}
}

func TestPreloadImageListRefusesAnEmptyRender(t *testing.T) {
	if _, err := PreloadImageList(nil); err == nil {
		t.Fatal("an empty image list was accepted")
	}
}

func TestArgoChartTemplateArgsMirrorTheRunnersInstall(t *testing.T) {
	dir := t.TempDir()
	if err := WriteArgoInstallValues(dir); err != nil {
		t.Fatal(err)
	}
	args := strings.Join(ArgoChartTemplateArgs(dir), " ")
	for _, want := range []string{
		"--version " + argocd.ResolvedArgoChartVersion(),
		"--set redisSecretInit.enabled=false",
		"-f " + filepath.Join(dir, "argocd-probes.yaml"),
		"-f " + filepath.Join(dir, "argocd-resources.yaml"),
	} {
		if !strings.Contains(args, want) {
			t.Errorf("helm args %q lack %q", args, want)
		}
	}
	for _, f := range []string{"argocd-probes.yaml", "argocd-resources.yaml"} {
		if b, err := os.ReadFile(filepath.Join(dir, f)); err != nil || len(b) == 0 {
			t.Errorf("%s not written: %v", f, err)
		}
	}
}

func TestWriteArgoInstallValuesFailsOnAMissingDir(t *testing.T) {
	if err := WriteArgoInstallValues(filepath.Join(t.TempDir(), "absent")); err == nil {
		t.Fatal("writing into a missing directory succeeded")
	}
}

func TestReadImageList(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "images.txt")
	if err := os.WriteFile(p, []byte("# pulled by ci.yml\n\nquay.io/a:v1\n  ghcr.io/b:v2  \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := ReadImageList(p)
	if err != nil || !reflect.DeepEqual(got, []string{"quay.io/a:v1", "ghcr.io/b:v2"}) {
		t.Fatalf("got %q, %v", got, err)
	}
	empty := filepath.Join(dir, "empty.txt")
	if err := os.WriteFile(empty, []byte("# nothing\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadImageList(empty); err == nil {
		t.Fatal("an empty list was accepted")
	}
	if _, err := ReadImageList(filepath.Join(dir, "absent")); err == nil {
		t.Fatal("a missing file was accepted")
	}
}

// scriptedKind replays a scripted sequence of `kind` answers and records every call.
type scriptedKind struct {
	answers []kindAnswer
	calls   [][]string
}

type kindAnswer struct {
	out string
	err error
}

func (f *scriptedKind) run(_ context.Context, args ...string) (string, error) {
	f.calls = append(f.calls, args)
	a := f.answers[0]
	if len(f.answers) > 1 {
		f.answers = f.answers[1:]
	}
	return a.out, a.err
}

func collectPreloadLogs() (func(string, ...interface{}), *[]string) {
	var lines []string
	return func(format string, args ...interface{}) {
		lines = append(lines, strings.TrimSpace(strings.ReplaceAll(fmt.Sprintf(format, args...), "\n", " ")))
	}, &lines
}

var errKindExit = errors.New("exit status 1")

func TestPreloadIntoKindWaitsForNodesWithoutCountingFailures(t *testing.T) {
	noNodes := kindAnswer{out: `ERROR: no nodes found for cluster "c"`, err: errKindExit}
	f := &scriptedKind{answers: []kindAnswer{noNodes, noNodes, noNodes, {out: ""}}}
	logf, lines := collectPreloadLogs()
	err := PreloadIntoKind(context.Background(), "c", []string{"a:1", "b:2"}, f.run, PreloadOptions{MaxFailures: 1}, logf)
	if err != nil {
		t.Fatalf("waiting for nodes was counted as a failure: %v", err)
	}
	if len(f.calls) != 4 {
		t.Fatalf("calls = %d, want 4", len(f.calls))
	}
	if want := []string{"load", "docker-image", "--name", "c", "a:1", "b:2"}; !reflect.DeepEqual(f.calls[0], want) {
		t.Fatalf("argv = %q, want %q", f.calls[0], want)
	}
	if got := strings.Join(*lines, "\n"); strings.Count(got, "has no nodes yet") != 1 || !strings.Contains(got, "pre-loaded 2 image(s)") {
		t.Fatalf("logs:\n%s", got)
	}
}

func TestPreloadIntoKindLogsThatASuccessRetried(t *testing.T) {
	f := &scriptedKind{answers: []kindAnswer{{out: "ctr: failed to import", err: errKindExit}, {out: ""}}}
	logf, lines := collectPreloadLogs()
	if err := PreloadIntoKind(context.Background(), "c", []string{"a:1"}, f.run, PreloadOptions{MaxFailures: 3}, logf); err != nil {
		t.Fatal(err)
	}
	got := strings.Join(*lines, "\n")
	if !strings.Contains(got, "attempt failed (1/3)") || !strings.Contains(got, "succeeded after 1 failed attempt(s)") {
		t.Fatalf("a retried success did not say it retried:\n%s", got)
	}
}

func TestPreloadIntoKindGivesUpAfterMaxFailures(t *testing.T) {
	f := &scriptedKind{answers: []kindAnswer{{out: "ctr: failed to import", err: errKindExit}}}
	logf, _ := collectPreloadLogs()
	err := PreloadIntoKind(context.Background(), "c", []string{"a:1"}, f.run, PreloadOptions{MaxFailures: 3}, logf)
	if err == nil || !strings.Contains(err.Error(), "failed 3 times") || len(f.calls) != 3 {
		t.Fatalf("err = %v, calls = %d; want a give-up after exactly 3", err, len(f.calls))
	}
}

func TestPreloadIntoKindStopsWhenTheContextEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	f := &scriptedKind{answers: []kindAnswer{{out: `no nodes found for cluster "c"`, err: errKindExit}}}
	logf, _ := collectPreloadLogs()
	err := PreloadIntoKind(ctx, "c", []string{"a:1"}, f.run, PreloadOptions{Poll: time.Hour, MaxFailures: 3}, logf)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestPreloadIntoKindRefusesNoImages(t *testing.T) {
	logf, _ := collectPreloadLogs()
	if err := PreloadIntoKind(context.Background(), "c", nil, (&scriptedKind{}).run, PreloadOptions{}, logf); err == nil {
		t.Fatal("an empty pre-load was accepted")
	}
}

// stubOnPath puts an executable `name` that runs script first on PATH for the test.
func stubOnPath(t *testing.T, name, script string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestArgoChartImagesReadsWhatHelmRenders(t *testing.T) {
	fixture := filepath.Join(t.TempDir(), "rendered.yaml")
	if err := os.WriteFile(fixture, []byte(renderedFixture), 0o600); err != nil {
		t.Fatal(err)
	}
	stubOnPath(t, "helm", `[ "$1" = template ] || exit 9; cat '`+fixture+`'`)
	got, err := ArgoChartImages(context.Background())
	if err != nil || len(got) != 3 || got[0] != "ecr-public.aws.com/docker/library/redis:8.2.3-alpine" {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestArgoChartImagesReportsAFailedRender(t *testing.T) {
	stubOnPath(t, "helm", "echo 'Error: chart \"argo-cd\" version \"0.0.0\" not found' >&2; exit 1")
	_, err := ArgoChartImages(context.Background())
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("err = %v, want helm's own stderr in the error", err)
	}
}

func TestArgoChartImagesReportsAnUnparseableRender(t *testing.T) {
	stubOnPath(t, "helm", "echo 'kind: [unclosed'")
	if _, err := ArgoChartImages(context.Background()); err == nil {
		t.Fatal("an unparseable render was accepted")
	}
}

func TestExecKindReturnsCombinedOutput(t *testing.T) {
	stubOnPath(t, "kind", `echo "out $*"; echo 'ERROR: no nodes found for cluster "c"' >&2; exit 1`)
	out, err := ExecKind(context.Background(), "load", "docker-image")
	if err == nil || !strings.Contains(out, "out load docker-image") || !strings.Contains(out, kindNoNodesMarker) {
		t.Fatalf("out = %q, err = %v", out, err)
	}
}
