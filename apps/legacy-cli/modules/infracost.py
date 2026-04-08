import os
import urllib.request
import tarfile
import json
from modules.logs import LOGS
from modules.utils import execute, get_system_architecture

myLOGS = LOGS()

class INFRACOST:
    def __init__(self, version="v0.10.39"):
        self.api_key = os.getenv('INFRACOST_API_KEY')
        self.version = version
        self.binary_path = f"bin/infracost_{self.version}"

    def check_token(self):
        """Check if the Infracost API token is set."""
        if not self.api_key:
            myLOGS.log("warn", "Infracost token not provided. Skipping cost estimation.")
            myLOGS.log("warn", "To include Infracost, run with --infracost-token <YOUR_API_KEY>")
            return False
        return True

    def _download_binary(self):
        """Download and extract the Infracost binary if it doesn't already exist."""
        if os.path.exists(self.binary_path):
            myLOGS.log("debug", f"Infracost {self.version} is already available.")
            return

        system_type, arch = get_system_architecture()
        download_url = f"https://github.com/infracost/infracost/releases/download/{self.version}/infracost-{system_type}-{arch}.tar.gz"
        myLOGS.log("info", f"Downloading Infracost {self.version} for {system_type}-{arch}...")

        os.makedirs("bin", exist_ok=True)
        tar_file_path = f"bin/infracost_{self.version}.tar.gz"
        urllib.request.urlretrieve(download_url, tar_file_path)

        # Extract the first (and expected single) file from the tarball
        with tarfile.open(tar_file_path, "r:gz") as tar:
            extracted_file_name = tar.getnames()[0]
            tar.extractall("bin")

        # Rename the extracted file to the desired binary path
        extracted_file_path = os.path.join("bin", extracted_file_name)
        os.rename(extracted_file_path, self.binary_path)
        os.chmod(self.binary_path, 0o775)
        os.remove(tar_file_path)
        myLOGS.log("info", f"Infracost {self.version} downloaded and extracted successfully.")


    def run_infracost(self, terraform_plan_file="temp/terraform.plan.json"):
        """Run Infracost cost estimation and output JSON and table formats."""
        if not self.check_token():
            return

        self._download_binary()

        # Define file paths for JSON and table output
        breakdown_json_path = "temp/infracost_breakdown.json"
        breakdown_table_path = "temp/infracost_breakdown_table.txt"

        # Run Infracost breakdown command
        myLOGS.log("info", "Running Infracost cost estimation...")
        breakdown_cmd = f"{self.binary_path} breakdown --path {terraform_plan_file} --format json --out-file {breakdown_json_path}"
        try:
            execute(breakdown_cmd, silent=True, log_file="./logs/infracost.breakdown.log")
        except Exception as error:
            myLOGS.log("warning", f"Failed to run Infracost breakdown: {error}. Check the log file ./logs/infracost.breakdown.log")
            return

        # Convert JSON breakdown to a table format
        output_cmd = f"{self.binary_path} output --format table --path {breakdown_json_path} --out-file {breakdown_table_path}"
        try:
            execute(output_cmd)
        except Exception as error:
            myLOGS.log("warning", f"Failed to convert Infracost JSON to table format: {error}")
            return

        # Load and log summary cost information from JSON breakdown
        try:
            with open(breakdown_json_path, "r") as breakdown_file:
                breakdown_data = json.load(breakdown_file)
                total_monthly_cost = breakdown_data.get("totalMonthlyCost", "N/A")
                diff_total_monthly_cost = breakdown_data.get("diffTotalMonthlyCost", "N/A")
                myLOGS.log("info", f"Cost Summary - Total Monthly Cost: ${total_monthly_cost}, Diff Monthly Cost: ${diff_total_monthly_cost}")
        except (json.JSONDecodeError, KeyError) as error:
            myLOGS.log("warning", f"Failed to parse cost summary: {error}")

        # Notify the user about the detailed cost breakdown table
        myLOGS.log("info", f"For detailed cost breakdown, see the table format in {breakdown_table_path}")

