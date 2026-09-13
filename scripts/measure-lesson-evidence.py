"""Count preserved lesson prompt payloads exported by lessonEvidence.integration.test.ts.

Install with: python -m pip install tiktoken==0.14.0
Counts visible text and JSON Schema, excluding provider framing
and hidden prompts. These are reproducible tokenizer counts, not billed usage.
"""

import argparse
import json
from pathlib import Path

import tiktoken


def count_request(request, encoding):
    text = "\n".join(part["text"] for part in request["input"])
    instructions = request["developerInstructions"]
    schema = json.dumps(request["outputSchema"], ensure_ascii=False, separators=(",", ":"))
    return {
        "input_text_tokens": len(encoding.encode(text)),
        "instruction_tokens": len(encoding.encode(instructions)),
        "schema_tokens": len(encoding.encode(schema)),
        "total_visible_input_tokens": sum(len(encoding.encode(part)) for part in (text, instructions, schema)),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    measurements = []
    for path in sorted(args.directory.glob("*-dossier.json")):
        fixture = json.loads(path.read_text(encoding="utf-8"))
        encoding = tiktoken.encoding_for_model(fixture["model"])
        materials = {material["materialId"]: material for material in fixture["materials"]}
        overlap_units = {
            (decision["materialId"], unit_index)
            for decision in fixture["selection"]["materials"]
            for overlap in decision["overlaps"]
            for unit_index in range(overlap["firstUnit"], overlap["lastUnit"] + 1)
        }
        overlaps = sum(
            len(materials[material_id]["units"][unit_index]["text"])
            for material_id, unit_index in overlap_units
        )
        measurements.append({
            "fixture": path.name,
            "model": fixture["model"],
            "encoding": encoding.name,
            "full_source_characters": fixture["fullCharacters"],
            "retained_source_characters": fixture["retainedCharacters"],
            "omitted_overlap_characters": overlaps,
            **{phase: [{"stage": row["stage"], **count_request(row["request"], encoding)} for row in fixture[phase]] for phase in ("before", "after")},
        })
    print(json.dumps(measurements, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
