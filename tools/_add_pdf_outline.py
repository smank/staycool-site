#!/usr/bin/env python3
"""Add a chapter bookmark outline to the manual PDF.

Usage: _add_pdf_outline.py <pdf> <manual-html>

Chapter titles come from the print TOC in the HTML (so the outline stays in
sync with the manual); page numbers come from the PDF's named destinations,
which Chrome creates as /chNN for each chapter id. No-ops (exit 0) if pypdf
is missing so the manual build never hard-depends on it.
"""
import sys, re

try:
    from pypdf import PdfReader, PdfWriter
except ImportError:
    print("  (pypdf not installed; skipping PDF outline)")
    sys.exit(0)

pdf_path, html_path = sys.argv[1], sys.argv[2]

html = open(html_path, encoding="utf-8").read()
m = re.search(r'class="toc-print".*?</div>', html, re.S)
block = m.group(0) if m else ""
entries = []
for a in re.finditer(r'href="#(ch\d+)">\s*<span class="n">(\d+)</span>([^<]+)</a>', block):
    anchor, num, title = a.group(1), a.group(2), a.group(3).strip().replace("&amp;", "&")
    entries.append((anchor, f"{num}.  {title}"))

if not entries:
    print("  (no chapter anchors in the TOC; skipping outline)")
    sys.exit(0)

reader = PdfReader(pdf_path)
nd = reader.named_destinations
writer = PdfWriter()
writer.append(reader)  # clones pages + annotations (keeps the TOC links)

added = 0
for anchor, label in entries:
    dest = nd.get("/" + anchor) or nd.get(anchor)
    if dest is None:
        continue
    try:
        page = reader.get_destination_page_number(dest)
    except Exception:
        continue
    writer.add_outline_item(label, page)
    added += 1

with open(pdf_path, "wb") as f:
    writer.write(f)
print(f"  added {added} PDF bookmarks")
