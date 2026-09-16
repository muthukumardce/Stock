"""Non-blocking resource telemetry for the local workstation."""
import os
import time

import psutil


class ResourceMonitor:
    def __init__(self):
        self.process = psutil.Process()
        self.at = 0.0
        self.current = {}
        psutil.cpu_percent(interval=None)

    def snapshot(self):
        if time.monotonic() - self.at >= 2:
            memory = psutil.virtual_memory()
            self.current = {"logical_cpus": os.cpu_count() or 1,
                            "cpu_percent": psutil.cpu_percent(interval=None),
                            "memory_total_gib": round(memory.total / 2**30, 1),
                            "memory_used_gib": round(memory.used / 2**30, 1),
                            "memory_percent": memory.percent,
                            "server_memory_mib": round(self.process.memory_info().rss / 2**20, 1)}
            self.at = time.monotonic()
        return dict(self.current)
