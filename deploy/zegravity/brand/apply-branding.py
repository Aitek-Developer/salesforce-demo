"""Apply the ZeGravity white-label edits (branding.json) to an upstream Twenty checkout.

Run from the repository root: python3 deploy/zegravity/brand/apply-branding.py
Idempotent: edits already applied are skipped. Fails loudly if upstream code
drifted so an anchor can no longer be found, so a rebrand never ships half-done.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = json.load(open(os.path.join(HERE, "branding.json"), encoding="utf-8"))

applied = skipped = 0
missing = []

for path, content in spec["new_files"].items():
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(content)
    applied += 1

for edit in spec["edits"]:
    path = edit["file"]
    text = open(path, encoding="utf-8").read()
    occurrences = text.count(edit["old"])
    if occurrences == 1:
        text = text.replace(edit["old"], edit["new"])
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        applied += 1
    elif occurrences == 0 and (not edit["new"] or edit["new"] in text):
        skipped += 1
    else:
        missing.append(path)

print(f"applied {applied}, already present {skipped}")
if missing:
    print("Could not apply branding to:", *sorted(set(missing)), sep="\n  ")
    sys.exit(1)
