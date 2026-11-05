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

## Where the files go

Into the app's data folder, under `models/hub/` (the Hugging Face cache layout:
`models--<org>--<name>/snapshots/<revision>/`). Deleting that folder removes them; the app asks
again before downloading them the next time you transcribe. Development and test runs use a folder
inside the checkout or a temporary folder, never the app's real data folder.
