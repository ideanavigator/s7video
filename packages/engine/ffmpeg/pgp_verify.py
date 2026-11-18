# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Checks an OpenPGP detached signature without gpg, which macOS does not ship (S7V-016).

build.sh runs it with PGPy through ``uv tool run``:
``pgp_verify.py <key.asc> <expected fingerprint> <file.asc> <file>``.
Exit 0 only when the key has the pinned fingerprint and the signature over the file is good.
"""

from __future__ import annotations

import sys
import warnings


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print("usage: pgp_verify.py <key.asc> <fingerprint> <file.asc> <file>", file=sys.stderr)
        return 2
    key_path, expected, signature_path, data_path = argv
    # PGPy warns about its own deprecated crypto calls; they say nothing about this signature.
    warnings.filterwarnings("ignore")
    import pgpy

    key, _ = pgpy.PGPKey.from_file(key_path)
    fingerprint = str(key.fingerprint).replace(" ", "").upper()
    if fingerprint != expected.replace(" ", "").upper():
        print(f"pgp_verify: the key's fingerprint is {fingerprint}, not the pinned {expected}", file=sys.stderr)
        return 1
    signature = pgpy.PGPSignature.from_file(signature_path)
    with open(data_path, "rb") as handle:
        data = handle.read()
    if not key.verify(data, signature):
        print(f"pgp_verify: bad signature on {data_path}", file=sys.stderr)
        return 1
    print(f"pgp_verify: good signature by {fingerprint}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
