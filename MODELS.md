<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Models

s7video transcribes speech on your Mac with the models below (ADR-006). They are **downloaded on
first use, after you agree**, from Hugging Face, and are never part of this repository or the app
download. Every file is pinned to a revision and checked against its sha256 before it is used; a
file with the wrong checksum is deleted. After the download, transcription works offline.

| Model                                | Used for                                                           | Source                                                                                                                                                                                                                       | Revision                                   | Size                          | Licence    |
| ------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------- | ---------- |
| Qwen3-ASR 1.7B (8-bit MLX)           | Speech recognition, default                                        | [`mlx-community/Qwen3-ASR-1.7B-8bit`](https://huggingface.co/mlx-community/Qwen3-ASR-1.7B-8bit) (converted from [`Qwen/Qwen3-ASR-1.7B`](https://huggingface.co/Qwen/Qwen3-ASR-1.7B))                                         | `a8379a2e2f9e313c9292cdf1af4055ab56d50d55` | 2,467,856,503 bytes (2.47 GB) | Apache-2.0 |
| Qwen3-ASR 0.6B (8-bit MLX)           | Speech recognition, light (pre-selected on Macs with 8 GB or less) | [`mlx-community/Qwen3-ASR-0.6B-8bit`](https://huggingface.co/mlx-community/Qwen3-ASR-0.6B-8bit) (converted from [`Qwen/Qwen3-ASR-0.6B`](https://huggingface.co/Qwen/Qwen3-ASR-0.6B))                                         | `89e96d92ba34aca20b3e29fb10cc284097d1219f` | 1,010,771,234 bytes (1.01 GB) | Apache-2.0 |
| Qwen3-ForcedAligner 0.6B (8-bit MLX) | Word timings, used with either                                     | [`mlx-community/Qwen3-ForcedAligner-0.6B-8bit`](https://huggingface.co/mlx-community/Qwen3-ForcedAligner-0.6B-8bit) (converted from [`Qwen/Qwen3-ForcedAligner-0.6B`](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B)) | `0e1a68e91d815300c7c9754b2a7639378b23db15` | 1,276,473,392 bytes (1.28 GB) | Apache-2.0 |

- **Default pair** (1.7B + aligner): 3,744,329,895 bytes, about 3.7 GB.
- **Light pair** (0.6B + aligner): 2,287,244,626 bytes, about 2.3 GB.

The 8-bit MLX conversions are by the mlx-community organisation; the original models are by the
Qwen team (Alibaba Cloud). Both are published under the Apache License 2.0
([text](LICENSES/Apache-2.0.txt)).
s7video does not modify or redistribute the weights; your Mac fetches them from Hugging Face.

## Checksums

[`packages/engine/models.lock.json`](packages/engine/models.lock.json) is the full list: every
file of every model (weights, tokenizer and config) with its size and sha256. The weight files:

| Repository                                    | File                | Bytes         | sha256                                                             |
| --------------------------------------------- | ------------------- | ------------- | ------------------------------------------------------------------ |
| `mlx-community/Qwen3-ASR-1.7B-8bit`           | `model.safetensors` | 2,463,307,541 | `bf304b009cc7eca79283056f787b44c952d24ac22cec787b39732bba3c23c13c` |
| `mlx-community/Qwen3-ASR-0.6B-8bit`           | `model.safetensors` | 1,006,229,426 | `b5bfe4abc1b4c6e58b633096682ec2b6297298add1527119936107d211adf0e8` |
| `mlx-community/Qwen3-ForcedAligner-0.6B-8bit` | `model.safetensors` | 1,271,924,386 | `be19ef8ac4326d032e7673342930b14c2df30bd68c1632493b0f563e30829f91` |

The lock was made from the Hugging Face API at each pinned revision: the LFS sha256 of each weight
file, and for the small files a sha256 of the downloaded file whose git blob id matched the API.
Changing a model or revision goes through a ticket, and updates the lock and this page together.

## Word timing calibration

Qwen3-ForcedAligner reports times on a grid of `timestamp_segment_time` (80 ms in its config).
A word's reported start is the start of the step it begins in, so the engine moves each start
**half a step later** (40 ms), reading the step from the loaded aligner's config. Ends are left
as reported. This is a calibration on **one clip only**, `talking-head-01` (CC-BY-4.0, S7V-031),
against its 40 machine-made word marks (energy envelope plus captions/ASR agreement, not checked by
ear), so it must be re-measured on our own recordings.

Starts: 34 scored (`pause`/`gap` edges), frames at 24000/1001.

| Start shift | 1.7B mean abs error | 1.7B within 1 frame | 0.6B mean abs error | 0.6B within 1 frame |
| ----------- | ------------------- | ------------------- | ------------------- | ------------------- |
| 0 ms        | 31.5 ms             | 85%                 | 30.6 ms             | 85%                 |
| 20 ms       | 23.6 ms             | 91%                 | 22.9 ms             | 91%                 |
| 30 ms       | 25.6 ms             | 91%                 | 26.1 ms             | 91%                 |
| **40 ms**   | **30.7 ms**         | **94%**             | **31.2 ms**         | **94%**             |
| 60 ms       | 43.2 ms             | 85%                 | 44.9 ms             | 82%                 |

Ends (with the 40 ms start shift): 28 scored on 1.7B, 27 on 0.6B.

| End shift | 1.7B mean signed | 1.7B mean abs | 1.7B within 1 frame | 0.6B mean abs | 0.6B within 1 frame |
| --------- | ---------------- | ------------- | ------------------- | ------------- | ------------------- |
| **0 ms**  | +22.8 ms         | 43.4 ms       | **82%**             | 42.3 ms       | **85%**             |
| −20 ms    | +9.4 ms          | 35.3 ms       | 82%                 | 34.0 ms       | 85%                 |
| −40 ms    | −15.9 ms         | 39.5 ms       | 79%                 | 39.8 ms       | 78%                 |

Half a step is used for starts because it follows from how the aligner reports time, not from
fitting this clip (20 ms gives a lower mean, 40 ms more words within a frame). Ends are not shifted:
half a step makes them worse within a frame, and no smaller shift is justified by one clip.

## Where the files go

Into the app's data folder, under `models/hub/` (the Hugging Face cache layout:
`models--<org>--<name>/snapshots/<revision>/`). Deleting that folder removes them; the app asks
again before downloading them the next time you transcribe. Development and test runs use a folder
inside the checkout or a temporary folder, never the app's real data folder.
