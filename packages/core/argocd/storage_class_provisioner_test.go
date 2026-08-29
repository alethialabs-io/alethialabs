// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The default StorageClass names a CSI driver, and naming the wrong one fails SILENTLY.
//
// `volumeBindingMode: WaitForFirstConsumer` means nothing happens until a pod wants the volume, and
// when nothing then happens the only symptom is the scheduler giving up on the POD:
//
//	Warning FailedScheduling  running PreBind plugin "VolumeBinding":
//	                          binding volumes: context deadline exceeded
//
// No event on the class, no event naming the provisioner, nothing in any Application's health that
// points at storage. aws/addons run 33243599078 lost six Applications to it — harbor,
// kube-prometheus-stack, loki, minio, tempo and vault, every one a chart that owns a volume — while
// the twelve that own none went Healthy+Synced. It survived that long because no earlier aws cell
// provisions a PVC AT ALL: floor, gitops, byo-iac and day2 install only controllers.
//
// The two names differ by a substring, which is exactly the kind of thing a reviewer's eye slides
// over:
//
//	ebs.csi.aws.com            ← the aws-ebs-csi-driver EKS add-on, which this cluster installs
//	ebs.csi.eks.amazonaws.com  ← EKS AUTO MODE's built-in storage capability, which it does not
//
// So this is asserted against the tofu that decides which of the two the cluster gets, not against
// a constant retyped here. Switch the cluster to Auto Mode and the add-on disappears from eks.tf;
// this test then fails and the class has to be revisited, rather than the cluster silently losing
// every volume again.
package argocd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ebsCSIDriverName is the CSIDriver the `aws-ebs-csi-driver` add-on registers. MEASURED from the
// upstream chart, not remembered:
//
//	helm template ebs aws-ebs-csi-driver/aws-ebs-csi-driver | grep -A2 'kind: CSIDriver'
//	  → name: ebs.csi.aws.com
const ebsCSIDriverName = "ebs.csi.aws.com"

// autoModeEBSDriverName is the other one, kept so the test can say WHICH wrong answer it found.
const autoModeEBSDriverName = "ebs.csi.eks.amazonaws.com"

func TestAWSDefaultStorageClassNamesTheDriverTheClusterInstalls(t *testing.T) {
	repoRoot := filepath.Join("..", "..", "..")

	// 1 · The cluster installs the add-on — i.e. it is NOT EKS Auto Mode, whose storage capability
	//     is built in and registers the other driver name.
	eksTF, err := os.ReadFile(filepath.Join(repoRoot, "infra", "templates", "project", "aws", "modules", "eks", "eks.tf"))
	if err != nil {
		t.Fatalf("reading the EKS module: %v — refusing to report the provisioner as correct against a file that is not there", err)
	}
	if !strings.Contains(string(eksTF), `addon_name               = "aws-ebs-csi-driver"`) {
		t.Fatalf("the EKS module no longer installs the aws-ebs-csi-driver add-on. The default " +
			"StorageClass's provisioner is derived from that choice, so it must be revisited: an " +
			"Auto Mode cluster wants " + autoModeEBSDriverName + ", an add-on cluster wants " + ebsCSIDriverName + ".")
	}

	// 2 · The class names that add-on's driver.
	sc, err := os.ReadFile(filepath.Join(repoRoot, "infra", "templates", "argocd", "storage-class-gp3.yaml"))
	if err != nil {
		t.Fatalf("reading the gp3 StorageClass: %v", err)
	}
	body := string(sc)
	// The comment block names both drivers deliberately, so match the DIRECTIVE line, not the file.
	var provisioner string
	for _, ln := range strings.Split(body, "\n") {
		if strings.HasPrefix(ln, "provisioner:") {
			provisioner = strings.TrimSpace(strings.TrimPrefix(ln, "provisioner:"))
		}
	}
	if provisioner == "" {
		t.Fatal("no `provisioner:` directive in storage-class-gp3.yaml — this test would otherwise pass having matched nothing")
	}
	if provisioner == autoModeEBSDriverName {
		t.Fatalf("the default StorageClass names %s, which is EKS AUTO MODE's driver. This cluster "+
			"installs the aws-ebs-csi-driver add-on, which registers %s — so NO controller watches "+
			"this class, every PVC stays Pending, and the only symptom is the scheduler's "+
			"`VolumeBinding: binding volumes: context deadline exceeded` on the pod.",
			provisioner, ebsCSIDriverName)
	}
	if provisioner != ebsCSIDriverName {
		t.Fatalf("the default StorageClass names %q; the add-on this cluster installs registers %q", provisioner, ebsCSIDriverName)
	}
}
