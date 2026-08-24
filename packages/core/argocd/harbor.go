// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"math/big"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// Pull credentials for an in-cluster Harbor registry (#2431).
//
// Hetzner has no registry product, so a canvas `registry` node becomes a Harbor release. The chart
// installs and nothing can pull from it: on every other cloud a project's own registry needs no
// imagePullSecret because the nodes authenticate to ECR / Artifact Registry / ACR with their own
// identity, and an in-cluster Harbor has no node identity.
//
// This file is the runner half. It seeds Harbor's admin password, then applies a one-shot Job that
// mints a project-scoped PULL robot from inside the cluster (`alethia harbor-bootstrap`) — inside,
// because Harbor's API answers only on the cluster network and the runner has no route to it.
//
// ── Everything here is applied with ApplyManifest, never committed to the apps repo ───────────
//
// The apps Application runs `automated: {prune: true, selfHeal: true}` with no `ignoreDifferences`
// (infra/templates/argocd/user-apps.yaml), so a Secret declared in git is healed back to its
// declared value. A minted credential committed there would be reverted by the very sync that
// minted it, and a hook that re-mints each reconcile would rotate Harbor's robot secret forever
// while no pod could pull. That hazard is already shipped on another path and is filed as #2435.
// registry_secrets.go states the rule this follows: "deliberately NO ArgoCD tracking metadata: no
// Application owns it, so nothing syncs it away."

const (
	// harborAdminSecretKey is the data key Harbor's chart reads the admin password from. It pairs
	// with `existingSecretAdminPasswordKey` in the rendered values — the two must agree or the chart
	// silently falls back to its default password.
	harborAdminSecretKey = "HARBOR_ADMIN_PASSWORD"
	// harborAdminPasswordBytes is the entropy of the generated admin password before encoding.
	harborAdminPasswordBytes = 32
	// harborBootstrapSAName is the ServiceAccount the bootstrap Job runs as.
	harborBootstrapSAName = "alethia-harbor-bootstrap"
)

// HarborRegistry is one in-cluster registry the runner must credential.
type HarborRegistry struct {
	// Name is the canvas `registry` node's name.
	Name string
	// Namespace is where the Harbor release lives (the console's NS.registry).
	Namespace string
	// Host is the in-cluster registry host — the SAME string hetznerRegistryHost() produced for the
	// chart's externalURL and that the Talos containerd mirror trusts. All three must agree: a
	// dockerconfigjson keyed on a host the kubelet does not pull from is not an error anywhere, it
	// is simply never matched, and the pull fails looking exactly like a bad password.
	Host string
	// PullSecretName / PullSecretNamespace locate the dockerconfigjson app pods reference.
	PullSecretName      string
	PullSecretNamespace string
}

// AdminSecretName is the Secret holding this registry's Harbor admin password.
func (h HarborRegistry) AdminSecretName() string { return "harbor-" + h.Name + "-admin" }

// BootstrapJobName is the one-shot Job that mints the robot.
func (h HarborRegistry) BootstrapJobName() string { return "harbor-" + h.Name + "-bootstrap" }

// valid reports whether every interpolated name is a safe RFC-1123 label. Fail-closed: these reach a
// kubectl command line and a rendered manifest.
func (h HarborRegistry) valid() bool {
	return k8sNameRe.MatchString(h.Name) &&
		k8sNameRe.MatchString(h.Namespace) &&
		k8sNameRe.MatchString(h.PullSecretName) &&
		k8sNameRe.MatchString(h.PullSecretNamespace) &&
		h.Host != "" && !strings.ContainsAny(h.Host, " \t\n\"'`$")
}

// EnsureHarborAdminSecret creates the Harbor admin password Secret if it does not already exist, and
// leaves an existing one alone.
//
// Alethia GENERATES this password — there is no user-entered credential for a `registry` node, and
// the #640 add-on secret rail only carries values fetched from the database. Without it the chart
// falls back to its published default (`harborAdminPassword: "Harbor12345"`), which is what #2430
// shipped.
//
// It is created once and then read, never rewritten. Rotating it on every deploy would change the
// password Alethia authenticates with while Harbor's own database still holds the previous one — an
// immediate lockout. The cluster is therefore the store of record for this credential, which also
// keeps it out of Postgres entirely: it is generated in memory, applied, and forgotten.
func EnsureHarborAdminSecret(reg HarborRegistry, stdout, stderr io.Writer) error {
	if !reg.valid() {
		return fmt.Errorf("refusing to seed a Harbor admin secret for invalid registry %q/%q", reg.Namespace, reg.Name)
	}
	name := reg.AdminSecretName()
	// `kubectl get` decides idempotency. `create --dry-run | apply` would work too, but it would
	// REPLACE the password on every deploy, which is the lockout above.
	if err := utils.ExecuteCommand(
		fmt.Sprintf("kubectl get secret %s -n %s", name, reg.Namespace),
		".", nil, io.Discard, io.Discard,
	); err == nil {
		fmt.Fprintf(stdout, "Harbor admin secret %s/%s already exists; leaving it in place\n", reg.Namespace, name)
		return nil
	}
	password, err := harborAdminPassword()
	if err != nil {
		return fmt.Errorf("generate Harbor admin password: %w", err)
	}
	fmt.Fprintf(stdout, "Seeding Harbor admin secret %s/%s...\n", reg.Namespace, name)
	// The password rides a rendered manifest into `kubectl apply -f <file>`, never argv.
	return ApplyManifest(harborAdminSecretManifest(reg.Namespace, name, password), stdout, stderr)
}

// harborRandReader is the entropy source, swappable so the failure path is testable. A password
// generated from a failed reader must never be emitted: silently falling back to something weaker is
// how a "random" credential becomes guessable, and nothing downstream would notice.
var harborRandReader io.Reader = rand.Reader

// harborAdminPassword generates a password satisfying Harbor's complexity rule (8-128 chars with
// upper, lower and a digit). base64 of 32 random bytes gives 43 chars of mixed case and digits; the
// suffix guarantees one of each so a fluke all-letter encoding cannot be rejected at install time —
// a failure that would only surface as a Harbor pod refusing to start.
func harborAdminPassword() (string, error) {
	buf := make([]byte, harborAdminPasswordBytes)
	if _, err := io.ReadFull(harborRandReader, buf); err != nil {
		return "", err
	}
	n, err := rand.Int(harborRandReader, big.NewInt(10))
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf) + fmt.Sprintf("aZ%d", n.Int64()), nil
}

// harborAdminSecretManifest renders the namespace + the admin password Secret.
func harborAdminSecretManifest(namespace, name, password string) string {
	return fmt.Sprintf(`apiVersion: v1
kind: Namespace
metadata:
  name: %s
---
apiVersion: v1
kind: Secret
metadata:
  name: %s
  namespace: %s
type: Opaque
data:
  %s: %s
`, namespace, name, namespace, harborAdminSecretKey, base64.StdEncoding.EncodeToString([]byte(password)))
}

// HarborBootstrapJobManifest renders the one-shot mint Job, its ServiceAccount, and a Role scoped to
// the single Secret it may touch.
//
// The RBAC is `get` + `patch` on exactly one resourceName — no `list`, no `watch` (which cannot be
// name-scoped and would expose every Secret in the namespace), and no `create` (which cannot be
// name-scoped either, which is why EnsureRegistryPullSecret pre-seeds the Secret from the runner
// instead of letting the Job create it).
//
// Honest scope note: on a dedicated cluster the apps-repo writer already has broad authority through
// ArgoCD, so this Role is defence-in-depth rather than a containment boundary. It is still worth
// having — it bounds what a compromise of THIS pod reaches — but it should not be described as
// isolating a hostile tenant.
func HarborBootstrapJobManifest(reg HarborRegistry, runnerImage string) (string, error) {
	if !reg.valid() {
		return "", fmt.Errorf("refusing to render a Harbor bootstrap Job for invalid registry %q/%q", reg.Namespace, reg.Name)
	}
	if runnerImage == "" {
		return "", fmt.Errorf("refusing to render a Harbor bootstrap Job with no runner image")
	}
	return fmt.Sprintf(`apiVersion: v1
kind: ServiceAccount
metadata:
  name: %[1]s
  namespace: %[2]s
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: %[1]s
  namespace: %[3]s
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["%[4]s"]
    verbs: ["get", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: %[1]s
  namespace: %[3]s
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: %[1]s
subjects:
  - kind: ServiceAccount
    name: %[1]s
    namespace: %[2]s
---
apiVersion: batch/v1
kind: Job
metadata:
  name: %[5]s
  namespace: %[2]s
spec:
  backoffLimit: 4
  ttlSecondsAfterFinished: 600
  template:
    spec:
      serviceAccountName: %[1]s
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: harbor-bootstrap
          image: %[6]s
          args:
            - harbor-bootstrap
            - --api-base=http://%[7]s
            - --registry-host=%[7]s
            - --project=%[8]s
            - --robot=alethia-pull
            - --secret-name=%[4]s
            - --secret-namespace=%[3]s
            - --admin-password-file=/harbor-admin/%[9]s
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: harbor-admin
              mountPath: /harbor-admin
              readOnly: true
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: harbor-admin
          secret:
            secretName: %[10]s
        - name: tmp
          emptyDir: {}
`,
		harborBootstrapSAName,   // 1
		reg.Namespace,           // 2
		reg.PullSecretNamespace, // 3
		reg.PullSecretName,      // 4
		reg.BootstrapJobName(),  // 5
		runnerImage,             // 6
		reg.Host,                // 7
		reg.Name,                // 8
		harborAdminSecretKey,    // 9
		reg.AdminSecretName(),   // 10
	), nil
}

// hetznerRegistryNamespace mirrors the console's NS.registry (hetzner-services.ts). Duplicated
// rather than imported because Go cannot read the TS mapper, and asserted against the generated
// fixture by test so it cannot drift silently.
const hetznerRegistryNamespace = "registries"

// HetznerRegistries derives the in-cluster registries a deploy must credential.
//
// Hetzner only. Every other cloud provisions a real registry whose nodes authenticate with their own
// identity, so there is nothing to seed and nothing to mint — returning a non-empty list there would
// create Jobs against a Harbor that does not exist.
func HetznerRegistries(vc *types.ProjectConfig) []HarborRegistry {
	if vc == nil || string(vc.Provider) != "hetzner" {
		return nil
	}
	out := make([]HarborRegistry, 0, len(vc.ContainerRegistries))
	for _, r := range vc.ContainerRegistries {
		if r.Name == "" {
			continue
		}
		reg := HarborRegistry{
			Name:      r.Name,
			Namespace: hetznerRegistryNamespace,
			// MUST equal hetznerRegistryHost() in the console, which also produced the chart's
			// externalURL, and the Talos containerd mirror entry. A test pins the shape.
			Host:                fmt.Sprintf("registry-%s.%s.svc.cluster.local", r.Name, hetznerRegistryNamespace),
			PullSecretName:      fmt.Sprintf("registry-%s-pull", r.Name),
			PullSecretNamespace: appNamespaceForPullSecret,
		}
		if !reg.valid() {
			continue
		}
		out = append(out, reg)
	}
	return out
}

// appNamespaceForPullSecret is where app pods reference the imagePullSecret from. It matches the
// namespace generateAppManifests renders services into.
const appNamespaceForPullSecret = "default"

// EnsureHarborPullCredentials runs the whole sequence for one in-cluster registry:
// seed the admin password, pre-create the pull Secret, then apply the mint Job.
//
// Ordering is load-bearing. The pull Secret is created FIRST so the Job's Role can be scoped to a
// single resourceName with `get` + `patch` — RBAC cannot name-scope `create`, so a Job that created
// its own Secret would need namespace-wide create authority.
func EnsureHarborPullCredentials(ctx context.Context, reg HarborRegistry, runnerImage string, stdout, stderr io.Writer) error {
	if err := EnsureHarborAdminSecret(reg, stdout, stderr); err != nil {
		return err
	}
	// An EMPTY placeholder, seeded on the rail that carries no ArgoCD tracking metadata — so nothing
	// heals it back once the Job writes the real credential into it (#2435).
	if err := EnsureRegistryPullSecret(reg.PullSecretName, reg.PullSecretNamespace, `{"auths":{}}`, stdout, stderr); err != nil {
		return fmt.Errorf("pre-seed the pull secret: %w", err)
	}
	job, err := HarborBootstrapJobManifest(reg, runnerImage)
	if err != nil {
		return err
	}
	// Re-applying replaces a completed Job's spec; delete first so a re-deploy actually re-runs the
	// verify step rather than failing on an immutable field.
	_ = utils.ExecuteCommand(
		fmt.Sprintf("kubectl delete job %s -n %s --ignore-not-found", reg.BootstrapJobName(), reg.Namespace),
		".", nil, io.Discard, io.Discard,
	)
	fmt.Fprintf(stdout, "Applying Harbor bootstrap Job for registry %s...\n", reg.Name)
	_ = ctx
	return ApplyManifest(job, stdout, stderr)
}
