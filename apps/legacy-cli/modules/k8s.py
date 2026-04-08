
from time import time
import boto3
import yaml
import os
from modules.logs import LOGS
from modules.utils import execute
import traceback
import subprocess

myLOGS = LOGS()
class K8S:
    profile = None
    session = None
    eks = None
    region = None

    def __init__(self, profile: str, region: str, dry_run: bool):
        self.profile = profile
        self.dry_run = dry_run
        self.region = region
        self.session = boto3.Session(profile_name=self.profile, region_name=self.region)
        self.eks = self.session.client('eks', region)

        self.apply_log_file = './logs/kubectl.apply.log'
        self.server_dryrun_log_file = './logs/kubectl.server-dryrun.log'

        # Clear log files at the start
        with open(self.apply_log_file, 'w'):
            pass
        with open(self.server_dryrun_log_file, 'w'):
            pass


    def getContext (self, clusterName: str):
        clusters = self.eks.list_clusters()["clusters"]
        if clusterName not in clusters:
            myLOGS.log("critical", f"configured cluster: {clusterName} not found among {clusters}")
            exit(1)

        kubeconfig_path = "temp/kubeconfig"

        # get cluster details
        cluster = self.eks.describe_cluster(name=clusterName)
        cluster_cert = cluster["cluster"]["certificateAuthority"]["data"]
        cluster_ep = cluster["cluster"]["endpoint"]
        cluster_arn = cluster["cluster"]["arn"]

        # build the cluster config hash
        cluster_config = {
            "apiVersion": "v1",
            "kind": "Config",
            "clusters": [
                {
                    "cluster": {
                        "server": str(cluster_ep),
                        "certificate-authority-data": str(cluster_cert)
                    },
                    "name": cluster_arn
                }
            ],
            "contexts": [
                {
                    "context": {
                        "cluster": cluster_arn,
                        "user": cluster_arn
                    },
                    "name": cluster_arn
                }
            ],
            "current-context": cluster_arn,
            "kind": "Config",
            "preferences": {},
            "users": [
                {
                    "name": cluster_arn,
                    "user": {
                        "exec": {
                            "apiVersion": "client.authentication.k8s.io/v1beta1",
                            "command": "aws",
                            "args": [
                                "--region",
                                self.region,
                                "eks",
                                "get-token",
                                "--cluster-name",
                                clusterName
                            ],
                            "env": [
                                {
                                    "name": "AWS_PROFILE",
                                    "value": self.profile
                                }
                            ]
                        }
                    }
                }
            ]
        }

        # Write in YAML.
        config_text=yaml.dump(cluster_config, default_flow_style=False)
        open(kubeconfig_path, 'w').write(config_text)
        os.chmod(kubeconfig_path,0o600)

    def exportVars (self, variables):
        for key, value in variables.items():
            os.environ[key.upper()] = value


    def apply(self, namespace, manifest, variables):
        self.exportVars(variables)

        CMD = f'kubectl apply -n {namespace} -f {manifest}'
        myLOGS.log("debug", f'Running kubectl apply command')

        server_dryrun_cmd = CMD + " --dry-run=server"

        if self.dry_run:
            # dry-run logic
            myLOGS.log("normal", "Performing server-side dry-run...")
            try:
                execute(server_dryrun_cmd, log_file='./logs/kubectl.server-dryrun.log', append=True, silent=True)
                myLOGS.log("normal", "Server-side dry-run succeeded.")
            except RuntimeError:
                myLOGS.log("normal", "Server-side dry-run failed. But since we're in --dry-run it might be expected.")
        else:
            # Non-dry-run logic
            myLOGS.log("normal", "Performing server-side dry-run before actual execution...")

            execute(server_dryrun_cmd, log_file='./logs/kubectl.server-dryrun.log', append=True, exit_on_failure=True)
            myLOGS.log("normal", "Server-side dry-run succeeded. Proceeding with actual command.")

            execute(CMD, log_file='./logs/kubectl.apply.log', append=True, exit_on_failure=True)
