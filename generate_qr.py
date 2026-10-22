"""Generate one printable QR code PNG per active campaign.

Usage:
    python generate_qr.py                    # reads campaigns.csv
    python generate_qr.py path/to/export.csv  # any CSV exported from the Campaigns tab

Each code encodes  {LINK_BASE_URL}/{slug}  (the Cloudflare Worker, instant redirect) when LINK_BASE_URL
is set in .env, otherwise  {WEB_APP_URL}?e={slug}  (the Apps Script "Continue to site" page).
These match the links made in the Sheet.
"""

import argparse
import csv
import math
import os
import re
import sys
from pathlib import Path
from urllib.parse import quote, urlsplit

import qrcode
from dotenv import load_dotenv
from qrcode.constants import ERROR_CORRECT_H

SLUG_PATTERN = re.compile(r"^[a-z0-9_-]{1,64}$")
TRUTHY = {"true", "yes", "y", "1"}
MIN_SIZE_PX = 1000
BORDER_MODULES = 6  # quiet zone; the QR spec minimum is 4


def load_link_prefix() -> str:
    """Everything before the slug in a tracked link."""
    load_dotenv()
    base = os.getenv("LINK_BASE_URL", "").strip()
    if base:
        parts = urlsplit(base)
        if parts.scheme != "https" or parts.query:
            sys.exit(f"LINK_BASE_URL should look like https://event-qr.<name>.workers.dev, got: {base}")
        return base.rstrip("/") + "/"
    url = os.getenv("WEB_APP_URL", "").strip()
    if not url:
        sys.exit("Neither LINK_BASE_URL nor WEB_APP_URL is set. Copy .env.example to .env and fill it in.")
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.path.endswith("/exec") or parts.query:
        sys.exit(f"WEB_APP_URL should be the deployment's https://.../exec URL with no query string, got: {url}")
    return url + "?e="


def read_active_slugs(csv_path: Path) -> list[tuple[str, str]]:
    if not csv_path.exists():
        sys.exit(f"{csv_path} not found. Export the Campaigns tab as CSV (File > Download > CSV).")
    with csv_path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fields = {(name or "").strip().lower(): name for name in reader.fieldnames or []}
        for required in ("slug", "name", "active"):
            if required not in fields:
                sys.exit(f"{csv_path} is missing the '{required}' column.")
        campaigns, seen = [], set()
        for row in reader:
            slug = (row[fields["slug"]] or "").strip().lower()
            if not slug:
                continue
            if not SLUG_PATTERN.match(slug):
                print(f"  skip  {slug!r}: slugs may only contain a-z, 0-9, hyphens and underscores")
                continue
            if slug in seen:
                print(f"  skip  {slug!r}: duplicate slug")
                continue
            seen.add(slug)
            if (row[fields["active"]] or "").strip().lower() not in TRUTHY:
                print(f"  skip  {slug!r}: inactive")
                continue
            campaigns.append((slug, (row[fields["name"]] or "").strip() or slug))
    return campaigns


def make_qr(data: str, out_path: Path) -> int:
    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_H, border=BORDER_MODULES)
    qr.add_data(data)
    qr.make(fit=True)
    modules = qr.modules_count + 2 * BORDER_MODULES
    qr.box_size = math.ceil(MIN_SIZE_PX / modules)
    img = qr.make_image(fill_color="black", back_color="white")
    img.save(out_path)
    return modules * qr.box_size


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("csv", nargs="?", default="campaigns.csv", help="Campaigns CSV (default: campaigns.csv)")
    parser.add_argument("--out", default="qr_codes", help="Output folder (default: qr_codes)")
    args = parser.parse_args()

    prefix = load_link_prefix()
    campaigns = read_active_slugs(Path(args.csv))
    if not campaigns:
        sys.exit("No active campaigns found; nothing to generate.")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    for slug, name in campaigns:
        link = prefix + quote(slug, safe="")
        size = make_qr(link, out_dir / f"{slug}.png")
        print(f"  ok    {slug:<20} {size}px  {name}  ->  {link}")
    print(f"\n{len(campaigns)} QR code(s) written to {out_dir}/. Test-scan each one before printing.")


if __name__ == "__main__":
    main()
