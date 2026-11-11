#!/usr/bin/env bash
# Sample GPU usage once per interval into a CSV, for lining up with the
# llmCalls metrics table (both use epoch milliseconds).
#
# Run on Molly (the host, not inside Docker), in its own tmux window:
#   scripts/gpu-monitor.sh                       # -> experiments/gpu-<timestamp>.csv, 1 s interval
#   scripts/gpu-monitor.sh experiments/run1.csv 500
# Stop with Ctrl+C.
#
# Columns: epoch_ms,gpu_index,util_gpu_pct,util_mem_pct,mem_used_mib,mem_total_mib,power_w,temp_c
set -euo pipefail

out="${1:-experiments/gpu-$(date +%Y%m%d-%H%M%S).csv}"
interval_ms="${2:-1000}"
mkdir -p "$(dirname "$out")"

echo "epoch_ms,gpu_index,util_gpu_pct,util_mem_pct,mem_used_mib,mem_total_mib,power_w,temp_c" > "$out"
echo "Writing GPU samples to $out every ${interval_ms} ms (Ctrl+C to stop)"

nvidia-smi \
  --query-gpu=index,utilization.gpu,utilization.memory,memory.used,memory.total,power.draw,temperature.gpu \
  --format=csv,noheader,nounits \
  -lms "$interval_ms" |
  while IFS= read -r line; do
    printf '%s,%s\n' "$(date +%s%3N)" "${line// /}" >> "$out"
  done
