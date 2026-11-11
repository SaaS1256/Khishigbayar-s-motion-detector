
import csv
import time
from pathlib import Path
from datetime import datetime

import serial

PORT = "COM16"
BAUD = 115200

VALID_LABELS = {
    "sitting",
    "standing",
    "walking",
    "running",
    "lying",
    "fall",
}

label = input("Movement label: ").strip().lower()

if label not in VALID_LABELS:
    raise SystemExit("Invalid label")

duration = int(input("Recording duration in seconds: "))

data_dir = Path(__file__).parent / "data"
data_dir.mkdir(parents=True, exist_ok=True)

timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
output_file = data_dir / f"{label}_{timestamp}.csv"

count = 0
start = time.monotonic()

with serial.Serial(PORT, BAUD, timeout=1) as ser:
    time.sleep(2)
    ser.reset_input_buffer()

    with output_file.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "t", "ax", "ay", "az",
            "gx", "gy", "gz", "label"
        ])

        print(f"Recording {label} for {duration} seconds...")

        while time.monotonic() - start < duration:
            line = ser.readline().decode(
                "utf-8", errors="ignore"
            ).strip()

            if not line.startswith("DATA,"):
                continue

            values = line.split(",")

            if len(values) != 8:
                continue

            try:
                row = [float(v) for v in values[1:]]
            except ValueError:
                continue

            writer.writerow(row + [label])
            count += 1

print(f"Saved: {output_file}")
print(f"Samples recorded: {count}")
