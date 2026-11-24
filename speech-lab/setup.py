#!/usr/bin/env python3
"""Download and verify the pinned speech runtimes and models for the Speech Recognition Lab.

Usage (from the repository root or anywhere):

    python3 speech-lab/setup.py            # download, verify, install
    python3 speech-lab/setup.py --verify   # only verify what is installed

Everything comes from speech-lab/pins.json and every file is checked against its SHA-256.
Downloads are cached in speech-lab/.cache/ and installed into speech-lab/vendor/ and
speech-lab/models/. All three folders are git-ignored. Needs Python 3.8+ and no packages.
"""

import argparse
import gzip
import hashlib
import io
import json
import os
import shutil
import sys
import tarfile
import urllib.request
import zipfile

LAB = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(LAB, ".cache")
VENDOR = os.path.join(LAB, "vendor")
MODELS = os.path.join(LAB, "models")
SAMPLES = os.path.join(LAB, "samples")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def fetch(url, sha256, name=None):
    """Download url into the cache (skipping if a verified copy exists); return the path."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name or url.rsplit("/", 1)[-1])
    if os.path.exists(path) and (sha256 is None or sha256_file(path) == sha256):
        print(f"  cached   {os.path.basename(path)}")
        return path
    print(f"  download {url}")
    tmp = path + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": "speech-lab-setup"})
    with urllib.request.urlopen(req) as r, open(tmp, "wb") as out:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while True:
            block = r.read(1 << 20)
            if not block:
                break
            out.write(block)
            done += len(block)
            if total:
                sys.stdout.write(f"\r           {done / 1048576:7.1f} / {total / 1048576:.1f} MB")
                sys.stdout.flush()
    if total:
        print()
    actual = sha256_file(tmp)
    if sha256 and actual != sha256:
        os.remove(tmp)
        sys.exit(f"SHA-256 mismatch for {url}\n  expected {sha256}\n  got      {actual}")
    os.replace(tmp, path)
    return path


def write_verified(dest, data, sha256):
    actual = sha256_bytes(data)
    if actual != sha256:
        sys.exit(f"SHA-256 mismatch for {dest}\n  expected {sha256}\n  got      {actual}")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as f:
        f.write(data)
    print(f"  ok       {os.path.relpath(dest, LAB)}")


def installed_ok(path, sha256):
    return os.path.exists(path) and sha256_file(path) == sha256


def extract_members(archive_path, mode, wanted):
    """Read only the named members (matched by basename) from a tar archive. No extractall."""
    found = {}
    with tarfile.open(archive_path, mode) as tar:
        for m in tar:
            base = os.path.basename(m.name)
            if m.isfile() and base in wanted and base not in found:
                found[base] = tar.extractfile(m).read()
    missing = set(wanted) - set(found)
    if missing:
        sys.exit(f"{archive_path} is missing {sorted(missing)}")
    return found


def setup_sherpa(pins, verify_only):
    print("Sherpa-ONNX runtime", pins["runtime"]["version"])
    rt = pins["runtime"]
    rt_dir = os.path.join(VENDOR, rt["dir"])
    if all(installed_ok(os.path.join(rt_dir, f), s) for f, s in rt["files"].items()):
        print("  installed and verified")
    elif verify_only:
        return False
    else:
        archive = fetch(rt["archive"]["url"], rt["archive"]["sha256"])
        files = extract_members(archive, "r:bz2", rt["files"].keys())
        for name, sha in rt["files"].items():
            write_verified(os.path.join(rt_dir, name), files[name], sha)

    md = pins["model"]
    print("Sherpa-ONNX model", md["dir"], "@", md["revision"][:7])
    md_dir = os.path.join(MODELS, md["dir"])
    for name, sha in md["files"].items():
        dest = os.path.join(md_dir, name)
        if installed_ok(dest, sha):
            print(f"  ok       {os.path.relpath(dest, LAB)}")
            continue
        if verify_only:
            return False
        path = fetch(md["baseUrl"] + name, sha, name=f"{md['dir']}--{name}")
        os.makedirs(md_dir, exist_ok=True)
        shutil.copyfile(path, dest)
        print(f"  ok       {os.path.relpath(dest, LAB)}")
    return True


def deterministic_targz(zip_path):
    """Repack a zip as a byte-reproducible .tar.gz (sorted entries, fixed owners and times)."""
    raw = io.BytesIO()
    with zipfile.ZipFile(zip_path) as z, tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for info in sorted(z.infolist(), key=lambda i: i.filename):
            name = info.filename
            if name.startswith("/") or ".." in name.split("/"):
                sys.exit(f"Unsafe path in {zip_path}: {name}")
            ti = tarfile.TarInfo(name.rstrip("/"))
            ti.mtime = 0
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = ""
            if info.is_dir():
                ti.type = tarfile.DIRTYPE
                ti.mode = 0o755
                tar.addfile(ti)
            else:
                data = z.read(info)
                ti.size = len(data)
                ti.mode = 0o644
                tar.addfile(ti, io.BytesIO(data))
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb", mtime=0, filename="") as gz:
        gz.write(raw.getvalue())
    return out.getvalue()


def setup_vosk(pins, verify_only):
    rt = pins["runtime"]
    print("vosk-browser", rt["version"])
    rt_dir = os.path.join(VENDOR, rt["dir"])
    if all(installed_ok(os.path.join(rt_dir, f), s) for f, s in rt["files"].items()):
        print("  installed and verified")
    elif verify_only:
        return False
    else:
        archive = fetch(rt["archive"]["url"], rt["archive"]["sha256"])
        files = extract_members(archive, "r:gz", rt["files"].keys())
        for name, sha in rt["files"].items():
            write_verified(os.path.join(rt_dir, name), files[name], sha)

    md = pins["model"]
    print("Vosk model", md["name"])
    dest = os.path.join(MODELS, md["archive"])
    expected = md.get("archiveSha256")
    if os.path.exists(dest) and (expected is None or sha256_file(dest) == expected):
        print(f"  ok       {os.path.relpath(dest, LAB)}")
        return True
    if verify_only:
        return False
    zip_path = fetch(md["zip"]["url"], md["zip"]["sha256"])
    data = deterministic_targz(zip_path)
    if expected and sha256_bytes(data) != expected:
        sys.exit(f"Repacked archive hash mismatch: expected {expected}, got {sha256_bytes(data)}")
    os.makedirs(MODELS, exist_ok=True)
    with open(dest, "wb") as f:
        f.write(data)
    print(f"  ok       {os.path.relpath(dest, LAB)} (repacked from verified zip, sha256 {sha256_bytes(data)[:12]}…)")
    return True


def setup_samples(pins, verify_only):
    print("Sample audio")
    for name, s in pins.get("samples", {}).get("files", {}).items():
        dest = os.path.join(SAMPLES, name)
        if installed_ok(dest, s["sha256"]):
            print(f"  ok       samples/{name}")
            continue
        if verify_only:
            return False
        path = fetch(s["url"], s["sha256"], name=f"sample--{name}")
        os.makedirs(SAMPLES, exist_ok=True)
        shutil.copyfile(path, dest)
        print(f"  ok       samples/{name}")
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--verify", action="store_true", help="only verify installed files")
    ap.add_argument("--no-samples", action="store_true", help="skip the optional sample WAV")
    args = ap.parse_args()
    with open(os.path.join(LAB, "pins.json")) as f:
        pins = json.load(f)
    ok = setup_sherpa(pins["sherpa"], args.verify)
    ok = setup_vosk(pins["vosk"], args.verify) and ok
    if not args.no_samples:
        ok = setup_samples(pins, args.verify) and ok
    if not ok:
        sys.exit("Some files are missing or do not match pins.json. Run without --verify to install.")
    print("\nDone. Start the local server:  python3 speech-lab/serve.py")
    print("then open http://localhost:8000/ and choose Tests in the sidebar.")


if __name__ == "__main__":
    main()
