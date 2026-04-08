import urllib.request
import zipfile
import os
import json
import subprocess
import traceback
import platform
from modules.dataclasses import *
from modules.logs import LOGS
from modules.utils import execute
import yaml
import hcl2

myLOGS = LOGS()

class TERRAFORM:

    def __init__(self):
        os.makedirs('temp', exist_ok=True)

    def build(self):
        pass

    def exportVars (self, variables):
        """
        Exports a list variables to the system, in order to be past to terraform executable

        Parameters
        ----------
        a : dict
            List of key-value pairs that are going to be exported.

        Returns
        -------
        Void
            Method does not have a return type
        """
        for key, value in variables.items():
            os.environ[key.upper()] = value

    def plan(self, dir: str, variables: dict, update_infra: bool):
        self.exportVars(variables)
        myLOGS.log( "debug", f'Workdir: {dir}' )

        # TF INIT
        myLOGS.log("normal", f'Initializing Terraform. For more info on progress check log file logs/terraform.init.log ...')
        CMD = 'cd {} && ../../bin/terraform_{} init -reconfigure -var-file={} -backend-config={}{}'.format(
            dir,
            variables["terraform_ver"],
            variables["var_file"],
            variables["backend_config"],
            " -upgrade" if update_infra else "",
        )

        execute(CMD, 'logs/terraform.init.log', exit_on_failure=True)

        # TF PLAN
        CMD = 'cd {} && ../../bin/terraform_{} plan -var-file={} -out=../../temp/terraform.plan.out'.format(
            dir,
            variables["terraform_ver"],
            variables["var_file"]
        )
        myLOGS.log("normal", f'Running Terraform plan command. For more info check log file logs/terraform.plan.log')
        execute(CMD, 'logs/terraform.plan.log', exit_on_failure=True)

        # Generate JSON plan file for Infracost
        CMD = 'cd {} && ../../bin/terraform_{} show -json ../../temp/terraform.plan.out > ../../temp/terraform.plan.json'.format(
            dir,
            variables["terraform_ver"]
        )
        myLOGS.log("normal", "Converting Terraform plan to JSON format for Infracost. For more info check logs/terraform.show.log")
        execute(CMD, 'logs/terraform.show.log', exit_on_failure=True)


    def apply(self, dir: str, variables: dict):
        self.exportVars(variables)
        myLOGS.log( "normal", f'Apply predefined tf plan from file: temp/terraform.plan.out' )
        CMD = 'cd {} && ../../bin/terraform_{} apply ../../temp/terraform.plan.out'.format(
            dir,
            variables["terraform_ver"]
        )
        execute(CMD, 'logs/terraform.apply.log', exit_on_failure=True)

    def download(self, version):
        myLOGS.log("debug", f'Downloading terraform v{version}')

        # This can be it's own function, but keeping the mess as minimal for this PR
        cpu_arch = platform.machine().lower()
        system_type = platform.system().lower()

        if system_type not in ['linux', 'darwin']:
            myLOGS.log("error", f'Unexpected system type {system_type}')

        if cpu_arch in ['arm', 'arm64']:
            arch = cpu_arch
        elif 'x86_64' in cpu_arch or 'amd64' in cpu_arch:
            arch = 'amd64'
        else:
            # Keeping it just in case the command does not provide exact string to match either of these.
            arch = 'amd64'

        if not os.path.exists( "bin/terraform_{}".format(version) ):
            urllib.request.urlretrieve(
                f"https://releases.hashicorp.com/terraform/{version}/terraform_{version}_{system_type}_{arch}.zip",
                f"bin/terraform_{version}.zip"
            )
            with zipfile.ZipFile("bin/terraform_{}.zip".format(version), 'r') as zip_ref:
                zip_ref.extractall("bin")
                os.rename( "bin/terraform", f"bin/terraform_{version}")
                os.chmod( f"bin/terraform_{version}", 0o775)

    #@staticmethod
    def dict_to_hcl2(self, value: dict, indent: int = 0) -> str:
        def serialize_key(key: str, indent: int) -> str:
            return f'"{key}"' if indent > 0 else key

        if value is None:
            return "null"
        elif isinstance(value, bool):
            return "true" if value else "false"
        elif isinstance(value, (int, float)):
            return str(value)
        elif isinstance(value, str):
            return f'"{value}"'  # May need more complex escaping
        elif isinstance(value, (list, tuple)):
            items = ",\n".join(self.dict_to_hcl2(v, indent + 2) for v in value)
            return f"[\n{items}\n]"
        elif isinstance(value, dict):
            items = "\n".join(
                f'{" " * indent}{serialize_key(k, indent)} = {self.dict_to_hcl2(v, indent + 2)}' for k, v in
                value.items()
            )
            return f"{{\n{items}\n{' ' * (indent - 2)}}}" if indent > 0 else items
        else:
            raise TypeError(f"Unsupported type: {type(value)}")
    #@staticmethod
    def dict_merge(self, base_tfvars: dict, override_config: dict, subitem = False) -> dict:
        for key, value in override_config.items():
            if key in base_tfvars:
                if isinstance(value, dict) and isinstance(base_tfvars[key], dict):
                    self.dict_merge(base_tfvars[key], value, True )
                else:
                    base_tfvars[key] = value
            if subitem and value is not None:
                base_tfvars[key] = value
        return base_tfvars

    def override_tfvars(self, config_filename, tfvars_filename: str, variables: dict):
        self.exportVars(variables)
        myLOGS.log( "normal", f'Overriding tfvars {tfvars_filename} with {config_filename}')
        # Read yaml config
        with open(config_filename, 'r') as stream:
            config_raw_dict = yaml.safe_load(stream)

        # Read hcl2 tfvars
        with open(tfvars_filename, 'r') as stream:
            hcl2_dict = hcl2.load(stream)

        # Override, serialize to hcl2 and fmt
        new_tfvars_dict = self.dict_merge(hcl2_dict, config_raw_dict)
        serialized_hcl2 = self.dict_to_hcl2(new_tfvars_dict)

        # Write the new tfvars
        with open(tfvars_filename, 'w') as stream:
            stream.write(serialized_hcl2)

        myLOGS.log( "normal", f'Performing terraform fmt on {tfvars_filename}' )
        base_dir = os.path.dirname(os.path.realpath(__file__))  # Gets the directory where terraform.py is located
        terraform_bin_path = os.path.join(base_dir, '..', 'bin', f'terraform_{variables["terraform_ver"]}')

        CMD = f'{terraform_bin_path} fmt {tfvars_filename}'
        return execute(CMD)


    def generate_backend_config(self, config, bkndcfg_filename: str, variables: dict):
        myLOGS.log( "normal", f'Generating backend config {bkndcfg_filename}')
        # Read yaml config
        config_raw_dict = {
            "bucket": f"{config.project_name}-{config.environment}-{config.region}-idp-state",
            "region": config.region,
            "key": f"{config.project_name}-{config.environment}-{config.region}-terraform.tfstate"
        }

        # Read hcl2 tfvars
        with open(bkndcfg_filename, 'r') as stream:
            hcl2_dict = hcl2.load(stream)

        # Override, serialize to hcl2 and fmt
        new_bkendcfg_dict = self.dict_merge(hcl2_dict, config_raw_dict)
        serialized_hcl2 = self.dict_to_hcl2(new_bkendcfg_dict)

        # Write the new tfvars
        with open(bkndcfg_filename, 'w') as stream:
            stream.write(serialized_hcl2)

        myLOGS.log( "normal", f'Performing terraform fmt on {bkndcfg_filename}' )
        base_dir = os.path.dirname(os.path.realpath(__file__))  # Gets the directory where terraform.py is located
        terraform_bin_path = os.path.join(base_dir, '..', 'bin', f'terraform_{variables["terraform_ver"]}')

        CMD = f'{terraform_bin_path} fmt {bkndcfg_filename}'
        return execute(CMD)


    def output(self, dir: str, variables: dict, output: str = ""):
        self.exportVars(variables)
        if output:
            myLOGS.log("normal", f"Getting specific Terraform output: '{output}'")
        else:
            myLOGS.log("normal", "Getting all Terraform outputs")

        CMD = f'cd {dir} && ../../bin/terraform_{variables["terraform_ver"]} output -json'

        result = execute(CMD)

        try:
            outputs = json.loads(result)
            if output:
                # Return specific output value, or None if it doesn't exist
                return outputs.get(output, {}).get("value", None)

            return outputs  # Return all outputs as a dict
        except json.JSONDecodeError as e:
            myLOGS.log("critical", f"Failed to parse Terraform outputs: {e}")
            exit(1)
