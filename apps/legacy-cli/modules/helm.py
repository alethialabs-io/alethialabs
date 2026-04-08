import os
from modules.logs import LOGS
from modules.utils import execute
import traceback
import subprocess
import re

myLOGS = LOGS()

class HELM:

    def __init__(self, dry_run):
        self.dry_run = dry_run

    def exportVars(self, variables):
        for key, value in variables.items():
            os.environ[key.upper()] = value

    def upgradeinstall(self, release_name, chart_dir, namespace, values_files, variables, set_json=None):
        self.exportVars(variables)

        values_flags = ""
        for vf in values_files:
            values_flags += f" -f {vf}"

        CMD = f'helm upgrade --install --create-namespace {release_name} {chart_dir} -n {namespace}{values_flags}'
        display_cmd = CMD

        if set_json:
            CMD += f" --set-json '{set_json}'"
            redacted_set_json = re.sub(r'("password"\s*:\s*)"[^"]*"', r'\1"***"', set_json)
            display_cmd += f" --set-json '{redacted_set_json}'"

        myLOGS.log("debug", 'Running helm upgrade command')

        server_dryrun_cmd = CMD + " --dry-run=server"
        template_cmd = CMD.replace('upgrade --install', 'template', 1)
        display_server_dryrun_cmd = display_cmd + " --dry-run=server"
        display_template_cmd = display_cmd.replace('upgrade --install', 'template', 1)

        if self.dry_run:
            # dry-run logic
            myLOGS.log("normal", "Performing server-side dry-run...")
            try:
                execute(server_dryrun_cmd, log_file='./logs/helm.server-dryrun.log', silent=True, display_cmd=display_server_dryrun_cmd)
                myLOGS.log("normal", "Server-side dry-run succeeded.")
            except RuntimeError:
                myLOGS.log("normal", "Server-side dry-run failed. Falling back to helm template rendering...")

                # Using helm template as fallback for client-side rendering
                execute(template_cmd, log_file='./logs/helm.template.log', exit_on_failure=True, display_cmd=display_template_cmd)
                myLOGS.log("normal", "Helm template rendering succeeded.")
        else:
            # Non-dry-run logic
            myLOGS.log("normal", "Performing server-side dry-run before actual execution...")

            execute(server_dryrun_cmd, log_file='./logs/helm.server-dryrun.log', exit_on_failure=True, display_cmd=display_server_dryrun_cmd)

            myLOGS.log("normal", "Server-side dry-run succeeded. Proceeding with actual command.")

            execute(CMD, log_file='./logs/helm.install.log', exit_on_failure=True, display_cmd=display_cmd)
