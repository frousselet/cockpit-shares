#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-2.1-or-later
"""Write po/fr.po from po/shares.pot and tools/fr-translations.py.

The translations live in a Python table so that they can be reviewed and
regenerated after "make po/shares.pot" without losing the source references
that the Cockpit po plugin needs.
"""

import pathlib
import re
import runpy
import sys

root = pathlib.Path(__file__).resolve().parent.parent
T = runpy.run_path(str(root / "tools" / "fr-translations.py"))["T"]


def unquote(parts):
    return "".join(eval(p) for p in parts)  # PO strings are C string literals


def quote(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


pot = (root / "po" / "shares.pot").read_text(encoding="utf-8")
entries = pot.strip().split("\n\n")
out = ["""# French translation of the Cockpit file sharing page
msgid ""
msgstr ""
"Project-Id-Version: cockpit-shares\\n"
"Language: fr\\n"
"MIME-Version: 1.0\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Content-Transfer-Encoding: 8bit\\n"
"Plural-Forms: nplurals=2; plural=n > 1;\\n"
"""]
missing = []
for e in entries[1:]:
    comments = [l for l in e.split("\n") if l.startswith("#")]
    fields = {}
    cur = None
    for l in e.split("\n"):
        if l.startswith("#"):
            continue
        m = re.match(r'^(msgctxt|msgid_plural|msgid|msgstr(?:\[\d\])?) (".*")$', l)
        if m:
            cur = m.group(1)
            fields[cur] = [m.group(2)]
        elif l.startswith('"') and cur:
            fields[cur].append(l)
    msgid = unquote(fields["msgid"])
    plural = unquote(fields["msgid_plural"]) if "msgid_plural" in fields else None
    block = [c for c in comments if not c.startswith("#,")]
    if "msgctxt" in fields:
        block.append("msgctxt " + quote(unquote(fields["msgctxt"])))
    block.append("msgid " + quote(msgid))
    if plural is not None:
        tr = T.get((msgid, plural))
        if tr is None:
            missing.append(msgid)
            tr = ("", "")
        block.append("msgid_plural " + quote(plural))
        block.append("msgstr[0] " + quote(tr[0]))
        block.append("msgstr[1] " + quote(tr[1]))
    else:
        tr = T.get(msgid)
        if tr is None:
            missing.append(msgid)
            tr = ""
        block.append("msgstr " + quote(tr))
    out.append("\n".join(block))

(root / "po" / "fr.po").write_text("\n\n".join(out) + "\n", encoding="utf-8")
if missing:
    print("missing translations:", *missing, sep="\n  ", file=sys.stderr)
    sys.exit(1)
print(f"po/fr.po: {len(entries) - 1} messages")
