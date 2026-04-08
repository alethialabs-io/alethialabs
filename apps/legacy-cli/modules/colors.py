import sys
import itertools
import time
# from modules.logs import LOGS

# myLOGS = LOGS()

class PCOLORS:
    HEADER = '\033[95m'
    OKBLUE = '\033[94m'
    OKCYAN = '\033[96m'
    OKGREEN = '\033[92m'
    WARNING = '\033[93m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'
    UNDERLINE = '\033[4m'

    loading = False

    def __init__ (self):
        pass

    def animate(self):
        # 
        timeRunning = 0
        for c in itertools.cycle(['|', '/', '-', '\\']):
            if self.loading:
                break
            sys.stdout.write("\r{}[{:.1f}]{} loading {}".format(
                self.OKBLUE,
                timeRunning,
                self.ENDC,
                c
            ))
            sys.stdout.flush()
            time.sleep(0.2)
            timeRunning += 0.2


#print(f"{PCOLORS.WARNING}Warning: No active frommets remain. Continue?{PCOLORS.ENDC}")