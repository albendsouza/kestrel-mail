"""Laya on the Mac's GPU for Kestrel Sort, through PyTorch MPS and laya-mps.

Kestrel Sort starts this in laya-mps's Python environment when the installed model has a GPU
checkpoint (see scripts/laya/install.mjs --torch):

    <laya-mps>/.venv/bin/python -I gpu_worker.py --model <checkpoint folder> [--memory reduced]

It prints {"ready": true, ...} once the model is loaded, then reads one JSON request per line on
stdin, {"id", "states", "questions"}, and answers one line on stdout, {"id", "answers"} or
{"id", "error"}. Answers have the shape laya-ts's predictBatch gives, so Sort treats both runtimes
alike. Each email gets one GPU pass with all its questions: on an M4 Pro that measured both
fastest and lightest. It exits when stdin closes, so it never outlives Sort.
"""

import argparse
import json
import sys
import time
from pathlib import Path

from laya_mps.runtime import configure_memory

configure_memory("mps")  # before the first GPU allocation, as laya-mps requires

import numpy as np  # noqa: E402
import torch  # noqa: E402
from laya.common import collate_items, temp_bucket  # noqa: E402
from laya_mps.laya_engine import compile_laya_question  # noqa: E402
from laya_mps.laya_loader import load_agent  # noqa: E402
from laya_mps.schema import DecisionRequest  # noqa: E402


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def r4(value):
    return round(float(value), 4)


def answer(agent, state, questions):
    request = DecisionRequest.model_validate({"state": state, "questions": questions})
    names = list(request.questions)
    items = [compile_laya_question(request, q, agent.tok, agent.cfg) for q in request.questions.values()]
    batch = collate_items([items], agent.tok.pad_token_id)
    tensors = [batch[k].to("mps") for k in ("input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype")]
    with torch.inference_mode():
        logits, _ = agent.model(*tensors)
    logits = logits.float().cpu().numpy()
    if not np.isfinite(logits).all():
        raise RuntimeError("Laya produced non-finite output")
    out = {}
    for row, (name, item) in enumerate(zip(names, items)):
        count = len(item["markers"])
        temperature = agent.temperature_by_options.get(
            temp_bucket(item["qtype"], count), agent.temperature[item["qtype"]]
        )
        scaled = logits[row, :count] / max(1e-3, float(temperature))
        p = np.exp(scaled - scaled.max())
        p /= p.sum()
        # answer_confidence is max(p), as laya-ts reports it; Kestrel gates filing on it.
        if questions[name]["type"] == "noul":
            out[name] = {"type": "noul", "noul": r4(p[1]), "answer_confidence": r4(p.max())}  # [false, true]
        else:
            labels = list(questions[name]["criteria"])
            out[name] = {
                "type": "choice",
                "choice": labels[int(p.argmax())],
                "probabilities": {label: r4(v) for label, v in zip(labels, p)},
                "answer_confidence": r4(p.max()),
            }
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--memory", default="reduced", choices=["minimal", "reduced", "full"])
    args = parser.parse_args()
    try:
        if not torch.backends.mps.is_available():
            raise RuntimeError("this Mac's GPU isn't available to PyTorch")
        started = time.perf_counter()
        agent = load_agent(args.model.resolve(), "mps", args.memory)
        torch.mps.synchronize()
    except Exception as e:  # noqa: BLE001 - reported to Sort, which falls back to the CPU
        send({"error": f"{type(e).__name__}: {e}"})
        return 1
    send({"ready": True, "device": "mps", "memory": args.memory, "load_seconds": round(time.perf_counter() - started, 1)})
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        try:
            answers = [answer(agent, s, request["questions"]) for s in request["states"]]
            send({"id": request["id"], "answers": answers})
        except Exception as e:  # noqa: BLE001
            send({"id": request["id"], "error": f"{type(e).__name__}: {e}"})
        finally:
            torch.mps.empty_cache()
    return 0


if __name__ == "__main__":
    sys.exit(main())
