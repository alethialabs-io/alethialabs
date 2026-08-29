// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"fmt"
	"io"
	"regexp"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// addonBootstrapAPIBaseRe bounds a bootstrap's API base to an in-cluster http(s) origin: scheme,
// DNS host, optional port, and NOTHING else. No path, no userinfo, no query — a credential smuggled
// into a URL's userinfo would ride the config snapshot into Postgres, which is precisely what
// AddOnBootstrap's contract forbids.
var addonBootstrapAPIBaseRe = regexp.MustCompile(`^https?://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$`)

// One-shot bootstraps for MARKETPLACE add-ons (#2717).
//
// Some charts install a component that is not usable until somebody performs a one-time operation
// against its API. A freshly installed HashiCorp Vault is the case this exists for: it is SEALED
// and UNINITIALISED, `vault status` exits 2, the readiness probe never passes, no pod is ever
// Ready, and the Application sits Progressing at any budget. hashicorp/vault-helm ships no init
// hook — upstream's position is that initialising is an operator act — so a marketplace that offers
// Vault as a one-click install offers something that cannot come up.
//
// ── Why the RUNNER applies a Job rather than doing it itself ────────────────────────────────────
//
// Vault answers on the cluster network only; the runner holds a kubeconfig and has no route to a
// ClusterIP. Same constraint as the platform Vault (vault.go) and Harbor (harbor.go), and the same
// reason it is the better shape anyway: the unseal key is generated, used and stored WITHOUT ever
// entering the runner process, a log line, or execution_metadata.
//
// ── Why it is applied, never committed to the apps repo ─────────────────────────────────────────
//
// The apps Application runs `automated: {prune: true, selfHeal: true}` with no
// `ignoreDifferences`, so a Secret declared in git is healed back to its declared value. A key
// minted by a Job and committed there would be reverted by the very sync that minted it — the
// hazard #2435 records.
//
// ── Why the DISPATCH is total ───────────────────────────────────────────────────────────────────
//
// An unknown Kind is an ERROR, not a skip. A skipped bootstrap is invisible: the deploy stays
// green, the add-on sits Progressing forever, and nothing says why. That is the failure mode this
// whole file exists to remove, so it must not be reintroduced by the dispatcher.

// addOnBootstrapName is the ServiceAccount / Role / RoleBinding / Job name for one add-on's
// bootstrap.
//
// Derived from the ADD-ON ID rather than from the bootstrap KIND, and that is not cosmetic: the
// caller deletes this Job by name before re-applying (a completed Job cannot be re-applied — its
// fields are immutable), and a name derived from the kind would make that delete target the wrong
// object the moment a second kind ships. A name derived from the id is correct for every kind that
// will ever exist, and it is also the name a person greps for when one add-on's bootstrap misbehaves.
func addOnBootstrapName(id string) string { return "alethia-bootstrap-" + id }

// EnsureAddOnBootstraps runs every marketplace add-on's one-shot bootstrap.
//
// Call it AFTER the add-on Applications have been applied and BEFORE waiting for them to converge:
// the Vault Job cannot reach a Vault whose Application has not been applied, and the Vault
// Application cannot converge until the Job has unsealed it. Applying the Job does not block on it
// finishing — the Job retries on its own, and the health wait that follows is what observes the
// result.
//
// Best-effort per add-on, like every other post-apply step in the deploy: one add-on's bootstrap
// failing to APPLY must not fail a cluster that is otherwise up. It is reported on stderr and the
// add-on's own health then reports it honestly rather than a green deploy hiding it.
func EnsureAddOnBootstraps(addons []types.AddOnInstall, runnerImage string, stdout, stderr io.Writer) {
	for i := range addons {
		a := addons[i]
		if a.Bootstrap == nil {
			continue
		}
		manifest, err := AddOnBootstrapManifest(a, runnerImage)
		if err != nil {
			fmt.Fprintf(stderr, "Warning: add-on %q bootstrap skipped: %v\n", a.ID, err)
			continue
		}
		// Delete first: re-applying a completed Job fails on immutable fields, so without this a
		// re-deploy silently never re-runs it — and a Vault whose pod restarted would stay sealed.
		//
		// Safe to interpolate: AddOnBootstrapManifest above returned without error, which means it
		// already refused anything that is not a DNS label.
		_ = utils.ExecuteCommand(
			fmt.Sprintf("kubectl delete job %s -n %s --ignore-not-found", addOnBootstrapName(a.ID), a.Namespace),
			".", nil, io.Discard, io.Discard,
		)
		fmt.Fprintf(stdout, "Applying the %q bootstrap for add-on %q...\n", a.Bootstrap.Kind, a.ID)
		if err := ApplyManifest(manifest, stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "Warning: add-on %q bootstrap apply failed: %v\n", a.ID, err)
		}
	}
}

// AddOnBootstrapManifest renders one add-on's bootstrap Job, its ServiceAccount and its RBAC.
//
// Split out from the apply so the DECISION and the RENDERING are testable without a cluster, which
// is where the mistakes live: an unsafe name interpolated into a manifest, or a Role wider than the
// one Secret the Job is allowed to write.
func AddOnBootstrapManifest(a types.AddOnInstall, runnerImage string) (string, error) {
	if a.Bootstrap == nil {
		return "", fmt.Errorf("add-on %q has no bootstrap to render", a.ID)
	}
	switch a.Bootstrap.Kind {
	case types.AddOnBootstrapVaultInit:
		return addOnVaultBootstrapManifest(a, runnerImage)
	default:
		// Total on purpose — see the file comment.
		return "", fmt.Errorf(
			"add-on %q asks for bootstrap kind %q, which this runner does not know how to perform; "+
				"a newer console has shipped a bootstrap this runner predates",
			a.ID, a.Bootstrap.Kind)
	}
}

// addOnVaultBootstrapManifest renders the Vault init/unseal Job.
//
// The Role is namespace-scoped and minimal: `get` + `create` + `patch` on Secrets in the add-on's
// OWN namespace, which is what writing the state Secret needs. `create` cannot be scoped by
// resourceNames, which is why the Role is confined to that one namespace rather than named to one
// Secret. Honest scope note, the same one vault.go makes: on a dedicated cluster the apps-repo
// writer already holds broad authority through ArgoCD, so this is defence-in-depth rather than a
// containment boundary against a hostile tenant.
//
// NOTHING SECRET TRAVELS IN argv. It is world-readable through /proc, so the args carry an address,
// two names and a namespace. The unseal key is minted by Vault inside the cluster and written
// straight to the Secret; it never appears here, in the Job's logs, or in the runner.
func addOnVaultBootstrapManifest(a types.AddOnInstall, runnerImage string) (string, error) {
	if runnerImage == "" {
		return "", fmt.Errorf("refusing to render a Vault bootstrap Job with no runner image")
	}
	// Every one of these interpolates into a manifest and then into a kubectl command line. The API
	// server already constrains them, but this renderer must not be the thing that trusts that.
	for field, v := range map[string]string{
		"add-on id":    a.ID,
		"namespace":    a.Namespace,
		"state secret": a.Bootstrap.StateSecret,
	} {
		if !k8sNameRe.MatchString(v) {
			return "", fmt.Errorf("refusing to render a Vault bootstrap Job with an unsafe %s %q", field, v)
		}
	}
	// The API base is not a k8s name and needs its own shape. It lands in an UNQUOTED YAML scalar
	// inside the Job's args, so a value carrying `#`, a newline or a stray `:` would not fail — it
	// would parse as a DIFFERENT manifest. Constrain it to what it is: an in-cluster http(s) origin.
	if !addonBootstrapAPIBaseRe.MatchString(a.Bootstrap.APIBase) {
		return "", fmt.Errorf(
			"refusing to render a Vault bootstrap Job with API base %q: expected an http(s) origin "+
				"like http://addon-vault.vault.svc.cluster.local:8200", a.Bootstrap.APIBase)
	}

	// The Namespace is created HERE and not assumed. ArgoCD creates an add-on's namespace with
	// `CreateNamespace=true` on its FIRST SYNC, which has not happened yet — this Job is applied
	// seconds after the Application is, precisely so a sealed Vault is opened before the health wait
	// begins. Without this the apply fails with `namespaces "vault" not found`, the bootstrap is
	// skipped with a warning, and the add-on sits Progressing exactly as it did before. ArgoCD then
	// adopts the namespace it finds, the way vault.go's platform Job has always relied on.
	return fmt.Sprintf(`apiVersion: v1
kind: Namespace
metadata:
  name: %[2]s
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: %[1]s
  namespace: %[2]s
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: %[1]s
  namespace: %[2]s
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "create", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: %[1]s
  namespace: %[2]s
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
  name: %[3]s
  namespace: %[2]s
spec:
  backoffLimit: 4
  # THE TTL DELETED THE EVIDENCE BEFORE ANYTHING READ IT.
  #
  # This Job is deliberately not waited on — the comment on EnsureAddOnBootstraps says so, and it is
  # right: "the health wait that follows is what observes the result". But that wait is the ArgoCD
  # convergence budget, which is 35 MINUTES for the 18-chart surface. At 600s the Job and its pod
  # were garbage-collected twenty-five minutes BEFORE the deadline dump ran, so the one artefact
  # that says why the bootstrap failed no longer existed by the time anything looked.
  #
  # Measured on aws/addons run 33249968471: 24 of 25 Applications Healthy+Synced, addon-vault
  # Progressing, and the vault pod own log ending at "core: root token generated" then "pre-seal
  # teardown complete" — Vault initialised and re-sealed, which is an init with no unseal after it.
  # The bootstrap therefore failed between those two steps, and the only step there is persisting
  # the unseal key. Which of init, persist or unseal it was is one line in the Job log, and the Job
  # was gone.
  #
  # 3600 outlives the whole convergence budget plus slack, and still cleans up long before the
  # cluster is torn down. It applies to Failed Jobs as much as Complete ones, which is the case that
  # matters: a Complete Job leaves nothing anyone needs.
  ttlSecondsAfterFinished: 3600
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
        - name: vault-bootstrap
          image: %[4]s
          args:
            - vault-bootstrap
            - --init-only
            - --api-base=%[5]s
            - --state-secret=%[6]s
            - --state-namespace=%[2]s
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
`,
		addOnBootstrapName(a.ID), // 1
		a.Namespace,              // 2
		addOnBootstrapName(a.ID), // 3
		runnerImage,              // 4
		a.Bootstrap.APIBase,      // 5
		a.Bootstrap.StateSecret,  // 6
	), nil
}
