#!/usr/bin/env bash
# Measure code quality for the Effect-standards migration.
#
# Usage:
#   bash docs/effect-standards/quality-snapshot.sh <label> [baseline.json]
#
# Runs the test suite with coverage and Fallow health, then prints a Markdown report and writes
# snapshot.json to $TMPDIR/quality-<label>/. Pass docs/effect-standards/baseline.json as the second
# argument to print a before/after table with deltas. The test suite must pass.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

label="${1:-snapshot}"
baseline="${2:-}"
out="${TMPDIR:-/tmp}/quality-${label}"
mkdir -p "$out"

npx vitest run --coverage --reporter=default --reporter=json --outputFile.json="$out/tests.json" \
  >"$out/vitest.txt" 2>&1
# fallow health exits non-zero when a function is over threshold; the snapshot still records it.
npx fallow health --coverage coverage/coverage-final.json --format json >"$out/health.json" \
  2>/dev/null || true

commit="$(git rev-parse --short HEAD)"
if [[ -n "$(git status --porcelain)" ]]; then commit="${commit}+dirty"; fi

COMMIT="$commit" python3 -I - "$out" "$label" "$baseline" <<'PY'
import glob
import json
import os
import re
import sys

out, label, baseline_path = sys.argv[1], sys.argv[2], sys.argv[3]
PKGS = ["claude-sdk-provider", "pi-web-tools"]

health = json.load(open(os.path.join(out, "health.json")))
tests = json.load(open(os.path.join(out, "tests.json")))
coverage = json.load(open("coverage/coverage-final.json"))
coverage_total = json.load(open("coverage/coverage-summary.json"))["total"]

# Pattern counts over production source. Direction: -1 means fewer is the Effect-standard goal.
PATTERNS = {
    "zod imports": (r'from "zod"', -1),
    "Data.TaggedError classes": (r"Data\.TaggedError\(", -1),
    "Schema.TaggedError classes": (r"Schema\.TaggedError", 1),
    "Effect.gen calls": (r"Effect\.gen\(", 0),
    "Effect.fn / fnUntraced": (r"Effect\.fn(?:Untraced)?\(", 0),
    "run* boundaries": (r"\.run(?:Promise|Sync|Fork|Callback)[A-Za-z]*\(", -1),
    "Context.Service definitions": (r"Context\.Service", 1),
    "Layer usages": (r"\bLayer\.", 1),
    "async generators": (r"async function\*", -1),
    "try blocks": (r"\btry \{", -1),
    "throw statements": (r"\bthrow ", -1),
    "type casts (excl. as const)": (r"\bas (?!const\b)[A-Z]\w*", -1),
    "oxlint-disable comments": (r"oxlint-disable", -1),
    "hand-written 'x in' guards": (r'"\w+" in ', -1),
}


def files(pkg, test):
    paths = glob.glob(f"packages/{pkg}/**/*.ts", recursive=True)
    return sorted(
        p for p in paths if ("/test/" in p) == test and "/node_modules/" not in p
    )


def loc(paths):
    return sum(len(open(p).read().splitlines()) for p in paths)


def pct(covered, total):
    return round(100 * covered / total, 2) if total else 100.0


def package_snapshot(pkg):
    prod = files(pkg, test=False)
    source = "\n".join(open(p).read() for p in prod)
    marker = f"packages/{pkg}/"

    results = [r for r in tests["testResults"] if marker in r["name"]]
    assertions = [a for r in results for a in r["assertionResults"]]

    statements = [0, 0]
    branches = [0, 0]
    for path, data in coverage.items():
        if marker not in path or "/test/" in path:
            continue
        hits = list(data["s"].values())
        statements[0] += sum(1 for h in hits if h > 0)
        statements[1] += len(hits)
        for arms in data["b"].values():
            branches[0] += sum(1 for h in arms if h > 0)
            branches[1] += len(arms)

    scores = [
        f for f in health["file_scores"] if marker in f["path"] and "/test/" not in f["path"]
    ]
    mi = [f["maintainability_index"] for f in scores]
    worst = min(scores, key=lambda f: f["maintainability_index"])
    functions = sum(f["function_count"] for f in scores)
    large = [
        f"{x['path'].split(marker)[1]}:{x.get('name')} ({x.get('line_count') or x.get('lines')} LOC)"
        for x in health["large_functions"]
        if marker in x["path"] and "/test/" not in x["path"]
    ]
    return {
        "metrics": {
            "production LOC": (loc(prod), -1),
            "test LOC": (loc(files(pkg, test=True)), 0),
            "tests passed": (sum(1 for a in assertions if a["status"] == "passed"), 0),
            "statement coverage %": (pct(*statements), 1),
            "branch coverage %": (pct(*branches), 1),
            "avg maintainability index": (round(sum(mi) / len(mi), 1), 1),
            "min maintainability index": (round(worst["maintainability_index"], 1), 1),
            "avg cyclomatic per function": (
                round(sum(f["total_cyclomatic"] for f in scores) / functions, 2),
                -1,
            ),
            "avg cognitive per function": (
                round(sum(f["total_cognitive"] for f in scores) / functions, 2),
                -1,
            ),
            "max CRAP": (max(f["crap_max"] or 0 for f in scores), -1),
            "functions over 60 LOC": (len(large), -1),
            **{
                name: (len(re.findall(pattern, source)), direction)
                for name, (pattern, direction) in PATTERNS.items()
            },
        },
        "worst file": worst["path"].split(marker)[1],
        "large functions": large,
    }


score = health["health_score"]
vital = health["vital_signs"]
snapshot = {
    "label": label,
    "commit": os.environ["COMMIT"],
    "repo": {
        "metrics": {
            "Fallow health score": (score["score"], 1),
            "hotspot penalty (churn-based)": (score["penalties"]["hotspots"], -1),
            "unit-size penalty": (score["penalties"]["unit_size"], -1),
            "avg maintainability index": (vital["maintainability_avg"], 1),
            "avg cyclomatic": (vital["avg_cyclomatic"], -1),
            "p90 cyclomatic": (vital["p90_cyclomatic"], -1),
            "duplication %": (vital["duplication_pct"], -1),
            "functions over 60 LOC per 1k": (vital["functions_over_60_loc_per_k"], -1),
            "tests passed": (tests["numPassedTests"], 0),
            "statement coverage %": (coverage_total["statements"]["pct"], 1),
            "branch coverage %": (coverage_total["branches"]["pct"], 1),
        },
        "grade": score["grade"],
    },
    "packages": {pkg: package_snapshot(pkg) for pkg in PKGS},
}
json.dump(snapshot, open(os.path.join(out, "snapshot.json"), "w"), indent=2)

base = json.load(open(baseline_path)) if baseline_path else None


def table(title, current, before):
    print(f"\n### {title}\n")
    if before is None:
        print("| Metric | Value |\n| --- | --- |")
        for name, (value, _) in current.items():
            print(f"| {name} | {value} |")
        return
    print("| Metric | Before | After | Delta | Verdict |\n| --- | --- | --- | --- | --- |")
    for name, (value, direction) in current.items():
        old = before.get(name, [None])[0]
        if old is None:
            print(f"| {name} | n/a | {value} | n/a | new |")
            continue
        delta = round(value - old, 2)
        verdict = "same"
        if delta and direction:
            verdict = "better" if delta * direction > 0 else "worse"
        elif delta:
            verdict = "changed"
        print(f"| {name} | {old} | {value} | {delta:+} | {verdict} |")


header = f"## Quality snapshot: {label} ({snapshot['commit']})"
if base:
    header += f" vs {base['label']} ({base['commit']})"
print(header)
table("Repository", snapshot["repo"]["metrics"], base and base["repo"]["metrics"])
for pkg, data in snapshot["packages"].items():
    table(pkg, data["metrics"], base and base["packages"][pkg]["metrics"])
    print(f"\nLowest maintainability: `{data['worst file']}`.")
    if data["large functions"]:
        print("Functions over 60 LOC: " + "; ".join(f"`{x}`" for x in data["large functions"]) + ".")
print(f"\nSnapshot written to `{os.path.join(out, 'snapshot.json')}`.")
PY
