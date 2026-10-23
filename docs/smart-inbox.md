# Smart inbox

Kestrel sorts mail with [Laya](https://github.com/NandhaKishorM/laya), an
Apache-2.0 encoder model that answers typed questions about text in one pass. It
generates no text, so there's nothing to parse and nothing it can make up. Kestrel
runs it on the Mac: on the GPU through PyTorch MPS when [laya-mps](https://github.com/afshinm/laya-mps)
is set up, otherwise on the CPU through ONNX Runtime. There are no hand-written sorting
rules: an earlier rules-first version was built, tried on a real inbox and dropped.

## What Laya is asked

The questions live in one place, `src/shared/sorting.ts`, and both the app and the
training scripts use them, so the model always sees exactly what it was trained on.

| Question | Type | Answers |
|---|---|---|
| `kind` | choice of 7 | person, pitch, marketing, newsletter, social, notification, calendar |
| `needs_reply` | yes/no | does it ask you something or ask you to do something? |
| `urgent` | yes/no | time-sensitive today: security alert, login code, payment problem, deadline, meeting today |
| `topic` | choice of 6, notices only | code, security, money, purchase, travel, other |

Laya reads what an inbox row shows: sender, subject, the snippet (up to 300
characters), and whether the mail came through a mailing list (a List-Unsubscribe
header). Sorting adds no Gmail calls.

A model only gets the `topic` question if its `questions.json` says it was trained
on it; older models are asked the first three.

## From answers to splits and labels

`labelsFor()` in `src/shared/sorting.ts`:

| Laya says | Auto label | Split |
|---|---|---|
| person, needs a reply | To respond | To reply |
| person, no reply needed | FYI | Important |
| calendar | Calendar | Calendar |
| notification, topic code | Code | Codes |
| notification, urgent | Important update (+ Security, Finance…) | Important |
| notification, routine | Security, Finance, Purchase, Travel or Notification | Updates |
| pitch / marketing / newsletter / social | Pitch / Marketing / News / Social | Other |

Marketing that Laya is at least 80% sure of is filed away (marked done with the
Gmail label `Kestrel/Marketing`) once you've agreed to it. Starred mail never is.

## Corrections

`L` sets a label for a sender. `verdictFor()` turns the label back into the answers
that would produce it, so a correction sorts exactly as if Laya had said it. It
applies to all of that sender's mail at once, outranks Laya, and is logged
(`correctionLog` in the cache) as a training example. On mail that was filed away,
any other label brings it back to the inbox.

## Rescue

**Done → Never opened → Find mail from people** reads mail archived while unread
(up to 1,500 conversations from the last 90 days or the inbox window, whichever is
longer). Laya sorts it, and whatever it would have put in Important, To reply or
Calendar is offered back. The Gmail summaries go through the background quota lane,
so a large Done takes a few minutes, with progress shown.

## Models

Laya's official checkpoints ship as PyTorch weights only. Kestrel needs ONNX, made
once with Laya's own export script and checked against PyTorch to within 1e-4:

```bash
python laya-ts/scripts/export_onnx.py --repo convaiinnovations/laya --subfolder multilingual --out-dir ./model
npm run laya:install -- ./model --id laya-multilingual-base
```

`laya:install` copies the model to
`~/Library/Application Support/kestrel-mail/models/laya-email` with a manifest of
SHA-256 sums. Pass `--questions <checkpoint>/questions.json` for a model trained
with topics. `KESTREL_LAYA_MODEL` points Kestrel at another folder.

### Which checkpoint

| Checkpoint | Speed (M4 Pro CPU) | Zero-shot kind accuracy | Fine-tune time (MPS) |
|---|---|---|---|
| English (ModernBERT-large, 421M) | about 0.35 s per email | 61% (best zero-shot) | over 4 hours |
| Multilingual (mmBERT, 322M) | about 0.13 to 0.2 s per email | 32% | about 20 minutes |

Zero-shot, neither is good enough. Fine-tuned, the multilingual checkpoint is fast,
small and accurate, and it reads Hinglish, so Kestrel uses it.

### On the GPU

Kestrel Sort runs Laya on the Mac's GPU when the installed model also has its PyTorch
checkpoint. It starts `src/sort/gpu_worker.py` in laya-mps's Python environment and talks to
it over stdin and stdout. If the worker can't start or a request fails, Sort sorts on the
CPU instead. `KESTREL_LAYA_DEVICE=cpu` forces the CPU.

```bash
git clone https://github.com/afshinm/laya-mps.git ../laya-mps
(cd ../laya-mps && uv sync --locked --no-dev)
npm run laya:install -- ./model --id laya-email-ft1 --torch <laya-train output> --gpu ../laya-mps
```

`--torch` is the PyTorch checkpoint the ONNX export was made from; laya-train writes it.
`--gpu-memory` picks laya-mps's memory setting (`reduced` by default). Both runtimes give
the same answers, so changing runtime doesn't re-sort anything.

Measured on an M4 Pro with 24 GB, on the newest 200 emails of a real inbox, with ft1 (3
questions per email):

| Runtime | One new email (median) | A backlog | Peak memory |
| --- | --- | --- | --- |
| CPU, ONNX Runtime, half the cores (what Sort did before) | 254 ms | 3.3 emails/s | 1.7 GB |
| CPU, all 14 cores | 253 ms | 2.8 emails/s | 2.8 GB |
| GPU, laya-mps `reduced` memory, one email per pass | 42 ms | about 24 emails/s | 1.6 GB |
| GPU, laya-mps `full` memory, one email per pass | 41 ms | about 24 emails/s | 3.1 GB |

- **Same answers:** all 200 GPU verdicts matched the CPU's: split, kind, needs-reply and
  urgent. The largest probability difference was 0.0001.
- **`full` memory gains nothing here:** it's no faster than `reduced` and holds 1.5 GB more.
- **Batching doesn't help on the GPU:** eight emails per pass took 47 ms each and peaked at
  3.6 GB, so the worker runs one email per pass.
- **The larger model:** typed-decisions (ModernBERT-large, 4 questions) went from 981 ms to
  132 ms per email.

`laya-training/mps/run.sh` (outside this repo) repeats the measurement.

### Fine-tuning

Training rows are built from labelled emails with `scripts/laya/rows.mjs`, which
asks the same questions Kestrel Sort asks:

```bash
node scripts/laya/rows.mjs data/*.jsonl --out rows --topics data/topics.jsonl
laya-train --data rows/train.jsonl --base <multilingual checkpoint> --out ft \
  --device mps --shuffle-options --label-smoothing 0.05 --epochs 3
python laya-ts/scripts/export_onnx.py --model-dir ft --out-dir model
node scripts/laya/eval.mjs model rows/test.jsonl golden.jsonl
```

Each input line is `{from, subject, body, mailing_list, kind, needs_reply, urgent,
topic?}`, or `{…, label}` for a correction exported from Kestrel. `rows.mjs` holds
out 15% of each kind for testing. `eval.mjs` scores a model the way Kestrel runs it,
reporting how often a thread lands in the right split, then each answer and the
worst mistakes.

The training data so far is about 3,100 synthetic emails written to look like a
VC's inbox in India, plus real corrections. Real mail used for testing never goes
into training. Training data and models are kept outside this repo.

### Results so far (first fine-tune)

| Test set | Right split: base → fine-tuned | Right kind: base → fine-tuned |
|---|---|---|
| 331 held-out sample emails | 78.5% → 95.5% | 61% → 97% |
| 177 threads from a real inbox, labelled by hand | 88.1% → 94.9% | 62% → 72% |

The first fine-tune's weak spots were security alerts and codes (it had no topic
question and too few urgent examples), short "Friday 12:30?"-style replies, and
promotions written to sound like a person. The next model is trained on all three.

## Not built yet

- Apple's on-device Foundation Models as a second opinion on low-confidence verdicts
  (it needs Apple Intelligence set up on the Mac).
- Hosting the fine-tuned model for download, so installs don't have to convert one.
- Shipping the GPU runtime in release builds. Today it needs a laya-mps checkout with its
  Python environment, about 700 MB. laya-mps found ONNX Runtime's Core ML route ran on
  the CPU, and the Neural Engine export capped inputs at 96 tokens.
