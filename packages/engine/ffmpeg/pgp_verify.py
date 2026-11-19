# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Checks an OpenPGP detached signature without gpg, which macOS does not ship (S7V-016).

build.sh runs it with PGPy from the hash-pinned build tools:

    pgp_verify.py <key.asc> <fingerprint> <file.asc> <file>   exit 0 only for a good signature
    pgp_verify.py --self-test [<key.asc>]                     the forgery cases below must fail
    pgp_verify.py --write-forgery <dir> <key.asc>             a grafted-subkey forgery, for review

Only a signature made by the pinned primary key itself is accepted. PGPy verifies with any
subkey in the key file without checking the subkey's binding, so a subkey grafted onto the real
key by someone else would otherwise pass (S7V-016 review, finding 1).
"""

from __future__ import annotations

import sys
import tempfile
import warnings
from pathlib import Path

# PGPy warns about its own deprecated crypto calls; they say nothing about the signature.
warnings.filterwarnings("ignore")

import pgpy  # noqa: E402
from pgpy.constants import HashAlgorithm, KeyFlags, PubKeyAlgorithm  # noqa: E402


def _normal(fingerprint: str) -> str:
    return fingerprint.replace(" ", "").upper()


def verify(key: pgpy.PGPKey, expected: str, signature: pgpy.PGPSignature, data: bytes) -> str | None:
    """None when the pinned primary key made a good signature over ``data``; else the reason."""
    fingerprint = _normal(str(key.fingerprint))
    if not key.is_primary or fingerprint != _normal(expected):
        return f"the key's fingerprint is {fingerprint}, not the pinned {_normal(expected)}"
    primary_id = key.fingerprint.keyid
    if signature.signer != primary_id:
        return f"the signature is by key {signature.signer}, not the primary key {primary_id}"
    if signature.signer_fingerprint and _normal(str(signature.signer_fingerprint)) != fingerprint:
        return f"the signature names {signature.signer_fingerprint}, not {fingerprint}"
    if not key.verify(data, signature):
        return "bad signature"
    return None


def _check_files(key_path: str, expected: str, signature_path: str, data_path: str) -> int:
    key, _ = pgpy.PGPKey.from_file(key_path)
    signature = pgpy.PGPSignature.from_file(signature_path)
    reason = verify(key, expected, signature, Path(data_path).read_bytes())
    if reason:
        print(f"pgp_verify: {data_path}: {reason}", file=sys.stderr)
        return 1
    print(f"pgp_verify: good signature by the primary key {_normal(expected)}")
    return 0


def _new_key(name: str) -> pgpy.PGPKey:
    key = pgpy.PGPKey.new(PubKeyAlgorithm.RSAEncryptOrSign, 2048)
    key.add_uid(pgpy.PGPUID.new(name), usage={KeyFlags.Sign, KeyFlags.Certify}, hashes=[HashAlgorithm.SHA256])
    return key


def forge(real: pgpy.PGPKey, data: bytes) -> tuple[str, pgpy.PGPSignature]:
    """The real public key with an attacker's signing subkey grafted on (bound by the attacker's
    own key, not the real one), and the attacker's signature over ``data``."""
    attacker = _new_key("attacker")
    subkey = pgpy.PGPKey.new(PubKeyAlgorithm.RSAEncryptOrSign, 2048)
    attacker.add_subkey(subkey, usage={KeyFlags.Sign})
    grafted = attacker.pubkey.subkeys[subkey.fingerprint.keyid]
    real._children[grafted.fingerprint.keyid] = grafted
    grafted._parent = real
    return str(real), subkey.sign(data, hash=HashAlgorithm.SHA256)


def self_test(key_path: str | None) -> int:
    """Fails unless a good primary-key signature passes and every forgery is refused."""
    data = b"ffmpeg tarball stand-in\n"
    honest = _new_key("release key")
    honest_sig = honest.sign(data, hash=HashAlgorithm.SHA256)
    public = honest.pubkey
    failures = []
    if verify(public, str(public.fingerprint), honest_sig, data) is not None:
        failures.append("a good primary-key signature was refused")
    if verify(public, str(public.fingerprint), honest_sig, data + b"x") is None:
        failures.append("a tampered file passed")
    if verify(public, "0" * 40, honest_sig, data) is None:
        failures.append("a key with another fingerprint passed")
    real = pgpy.PGPKey.from_file(key_path)[0] if key_path else honest.pubkey
    expected = str(real.fingerprint)
    forged_text, forged_sig = forge(real, data + b"tampered")
    with tempfile.TemporaryDirectory() as folder:
        forged_file = Path(folder) / "key.asc"
        forged_file.write_text(forged_text)
        reloaded, _ = pgpy.PGPKey.from_file(str(forged_file))
    if verify(reloaded, expected, forged_sig, data + b"tampered") is None:
        failures.append("a signature by a grafted attacker subkey passed")
    for failure in failures:
        print(f"pgp_verify self-test: {failure}", file=sys.stderr)
    if not failures:
        print("pgp_verify self-test: primary-key signature accepted; tampered file, other key and grafted subkey refused")
    return 1 if failures else 0


def write_forgery(folder: str, key_path: str) -> int:
    """Writes key.asc (real key plus grafted subkey), data and data.asc into ``folder``."""
    real, _ = pgpy.PGPKey.from_file(key_path)
    data = b"tampered ffmpeg tarball\n"
    forged_text, forged_sig = forge(real, data)
    out = Path(folder)
    out.mkdir(parents=True, exist_ok=True)
    (out / "key.asc").write_text(forged_text)
    (out / "data").write_bytes(data)
    (out / "data.asc").write_text(str(forged_sig))
    print(f"pgp_verify: wrote a grafted-subkey forgery for {real.fingerprint} to {out}")
    return 0


def main(argv: list[str]) -> int:
    if argv[:1] == ["--self-test"] and len(argv) <= 2:
        return self_test(argv[1] if len(argv) == 2 else None)
    if argv[:1] == ["--write-forgery"] and len(argv) == 3:
        return write_forgery(argv[1], argv[2])
    if len(argv) == 4:
        return _check_files(*argv)
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
