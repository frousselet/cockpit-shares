#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-2.1-or-later
"""Generate the smb.conf parameter catalog used by the Cockpit "shares" page.

The catalog is built from the documentation sources shipped with Samba:

  * docs-xml/smbdotconf/**/*.xml       one file per smb.conf parameter
  * lib/param/param_table.c            the accepted values of enum parameters
  * docs-xml/manpages/vfs_*.8.xml      the options of every VFS module
  * docs-xml/manpages/smb.conf.5.xml   the variable substitutions (%U, %m, ...)

Usage:
    tools/generate-smb-catalog.py SAMBA_SOURCE_DIR SAMBA_VERSION OUTPUT.json

A sparse checkout of the Samba repository is enough, see "make catalog".
"""

import html
import json
import pathlib
import re
import sys
import xml.etree.ElementTree as ET

SAMBA_NS = "http://www.samba.org/samba/DTD/samba-doc"
XML_ENTITIES = {"quot", "amp", "lt", "gt", "apos"}

# Tags rendered as inline code
CODE_TAGS = {
    "constant", "command", "filename", "literal", "varname", "option", "userinput",
    "computeroutput", "envar", "systemitem", "prompt", "parameter", "function",
    "type", "classname", "structname", "uri", "markup", "code",
}
BLOCK_PRE_TAGS = {"programlisting", "screen", "literallayout", "synopsis"}
ADMONITIONS = {"note": "Note", "warning": "Warning", "tip": "Tip", "important": "Important", "caution": "Caution"}


def preprocess(text: str) -> str:
    """Make a DocBook fragment parseable by ElementTree."""
    text = re.sub(r"<\?xml[^>]*\?>", "", text)
    text = re.sub(r"<!DOCTYPE[^>]*>", "", text)

    def entity(m: re.Match) -> str:
        name = m.group(1)
        if name in XML_ENTITIES or name.startswith("#"):
            return m.group(0)
        if name.startswith("pathconfig."):
            # build time paths: keep a readable placeholder
            return "${" + name.split(".", 1)[1] + "}"
        if name == "smb.conf":
            return "<filename>smb.conf</filename>"
        if name == "doc.version":
            return ""
        return name
    text = re.sub(r"&([#a-zA-Z][a-zA-Z0-9._-]*);", entity, text)
    return f'<root xmlns:samba="{SAMBA_NS}">{text}</root>'


def esc(s: str | None) -> str:
    return html.escape(s or "", quote=True)


def squash(s: str) -> str:
    return re.sub(r"\s+", " ", s)


def to_html(el: ET.Element, pre: bool = False) -> str:
    """Convert a DocBook element tree into a small, safe HTML subset."""
    tag = el.tag.split("}")[-1]
    inner_pre = pre or tag in BLOCK_PRE_TAGS

    def children() -> str:
        out = []
        if el.text:
            out.append(esc(el.text if inner_pre else squash(el.text)))
        for child in el:
            out.append(to_html(child, inner_pre))
            if child.tail:
                out.append(esc(child.tail if inner_pre else squash(child.tail)))
        return "".join(out)

    if tag in ("description", "root", "listitem_inner"):
        return children()
    if tag == "para" or tag == "simpara":
        return f"<p>{children().strip()}</p>"
    if tag == "smbconfoption":
        name = el.get("name", "")
        value = "".join(el.itertext()).strip()
        ref = f'<code class="smb-ref" data-param="{esc(name.lower())}">{esc(name)}</code>'
        return ref + (f" = <code>{esc(value)}</code>" if value else "")
    if tag == "smbconfsection":
        return f"<code>{esc(el.get('name', ''))}</code>"
    if tag in CODE_TAGS:
        return f"<code>{children()}</code>"
    if tag == "replaceable":
        return f"<code><em>{children()}</em></code>"
    if tag == "emphasis":
        if el.get("role") in ("bold", "strong"):
            return f"<strong>{children()}</strong>"
        return f"<em>{children()}</em>"
    if tag == "quote":
        return f"“{children()}”"
    if tag == "itemizedlist":
        return f"<ul>{''.join(to_html(c) for c in el if c.tag.split('}')[-1] == 'listitem')}</ul>"
    if tag == "orderedlist":
        return f"<ol>{''.join(to_html(c) for c in el if c.tag.split('}')[-1] == 'listitem')}</ol>"
    if tag == "listitem":
        return f"<li>{children().strip()}</li>"
    if tag == "variablelist":
        return f"<dl>{''.join(to_html(c) for c in el if c.tag.split('}')[-1] == 'varlistentry')}</dl>"
    if tag == "varlistentry":
        out = []
        for c in el:
            ctag = c.tag.split("}")[-1]
            if ctag == "term":
                out.append(f"<dt>{to_html(c)}</dt>")
            elif ctag == "listitem":
                el2 = ET.Element("listitem_inner")
                el2.text = c.text
                el2.extend(list(c))
                out.append(f"<dd>{to_html(el2).strip()}</dd>")
        return "".join(out)
    if tag == "term":
        return children().strip()
    if tag in BLOCK_PRE_TAGS:
        return f"<pre>{children().strip(chr(10))}</pre>"
    if tag == "ulink":
        url = el.get("url", "")
        text = children().strip() or esc(url)
        if not re.match(r"^(https?|ftp)://", url):
            return text
        return f'<a href="{esc(url)}" target="_blank" rel="noopener noreferrer">{text}</a>'
    if tag == "citerefentry":
        title = el.findtext("refentrytitle", "") or ""
        vol = el.findtext("manvolnum", "") or ""
        return f"<code>{esc(title.strip())}({esc(vol.strip())})</code>"
    if tag in ADMONITIONS:
        return f'<div class="smb-doc-{tag}"><strong>{ADMONITIONS[tag]}:</strong> {children().strip()}</div>'
    if tag in ("anchor", "indexterm", "comment", "remark", "footnote"):
        return ""
    if tag == "title":
        return f"<p><strong>{children().strip()}</strong></p>"
    if tag in ("informalexample", "example", "blockquote", "section", "sect1", "sect2", "refsect2", "refsect3"):
        return f"<div>{children()}</div>"
    if tag in ("link", "xref", "phrase", "manvolnum", "refentrytitle", "firstterm", "acronym",
               "abbrev", "application", "productname", "trademark", "foreignphrase",
               "wordasword", "citetitle", "personname", "glossterm", "subscript", "superscript"):
        return children()
    if tag == "member":
        return children()
    if tag == "simplelist":
        return ", ".join(to_html(c) for c in el)
    # Unknown tag: keep its text
    return children()


def tidy_html(s: str) -> str:
    s = re.sub(r"<p>\s*</p>", "", s)
    s = re.sub(r"\s+</p>", "</p>", s)
    s = re.sub(r"<p>\s+", "<p>", s)
    return s.strip()


def parse_enums(param_table: str) -> dict[str, list[dict]]:
    """Read every `static const struct enum_list NAME[] = {...};` table."""
    enums: dict[str, list[dict]] = {}
    table_rx = r"static const struct enum_list\s+(\w+)\[\]\s*=\s*\{(.*?)\{\s*-1\s*,\s*NULL\s*\}\s*,?\s*\}\s*;"
    for m in re.finditer(table_rx, param_table, re.S):
        name, body = m.group(1), m.group(2)
        groups: dict[str, dict] = {}
        order: list[str] = []
        for em in re.finditer(r"\{\s*([^,{}]+?)\s*,\s*(?:N_\()?\"([^\"]*)\"\)?\s*\}", body):
            cval, sval = em.group(1).strip(), em.group(2)
            if cval == "-1":
                continue
            if cval not in groups:
                groups[cval] = {"value": sval, "aliases": []}
                order.append(cval)
            else:
                groups[cval]["aliases"].append(sval)
        enums[name] = [groups[k] for k in order]
    return enums


def normalize_name(name: str) -> str:
    return re.sub(r"\s+", " ", name.strip().lower())


def function_key(fn: str) -> str:
    return fn.lstrip("_").lower()


def parameter_files(root: pathlib.Path):
    yield from sorted((root / "docs-xml" / "smbdotconf").rglob("*.xml"))


def parse_parameters(src: pathlib.Path, enums: dict[str, list[dict]]):
    params: list[dict] = []
    for f in parameter_files(src):
        category = f.parent.name
        tree = ET.fromstring(preprocess(f.read_text(encoding="utf-8", errors="replace")))
        for p in tree.findall(f"{{{SAMBA_NS}}}parameter"):
            entry = {
                "name": normalize_name(p.get("name", "")),
                "display": p.get("name", "").strip(),
                "context": p.get("context"),
                "type": p.get("type"),
                "category": category,
            }
            if p.get("removed") == "1":
                continue
            entry["deprecated"] = p.get("deprecated") == "1"
            entry["substitution"] = p.get("substitution") == "1"
            entry["synonym_of_function"] = p.get("function") if p.get("synonym") == "1" else None
            entry["function"] = p.get("function")
            enumlist = p.get("enumlist")
            if enumlist:
                if enumlist not in enums:
                    raise SystemExit(f"{f}: unknown enum list {enumlist}")
                entry["enum"] = enums[enumlist]
            entry["synonyms"] = [normalize_name(s.text or "") for s in p.findall("synonym")]
            entry["related"] = sorted({normalize_name(r.text or "") for r in p.findall("related")})
            defaults = [v for v in p.findall("value") if v.get("type") == "default"]
            examples = [v for v in p.findall("value") if v.get("type") == "example"]
            entry["default"] = "".join(defaults[0].itertext()).strip() if defaults else None
            entry["examples"] = ["".join(v.itertext()).strip() for v in examples]
            desc = p.find("description")
            entry["doc"] = tidy_html(to_html(desc)) if desc is not None else ""
            params.append(entry)
    return params


def resolve_synonyms(params: list[dict]) -> list[dict]:
    """Fold parameters flagged synonym="1" into the parameter they alias."""
    by_name = {p["name"]: p for p in params}
    by_function: dict[str, dict] = {}
    for p in params:
        if not p["synonym_of_function"]:
            by_function.setdefault(function_key(p["name"].replace(" ", "_")), p)
            if p["function"]:
                by_function.setdefault(function_key(p["function"]), p)

    result = []
    for p in params:
        fn = p["synonym_of_function"]
        if not fn:
            result.append(p)
            continue
        target = by_function.get(function_key(fn))
        if target is None:
            raise SystemExit(f"cannot resolve synonym {p['name']} -> {fn}")
        inverted = p["type"] == "boolean-rev"
        key = "inverted_synonyms" if inverted else "synonyms"
        names = [p["name"]] + p["synonyms"]
        target.setdefault(key, [])
        for n in names:
            if n not in target[key] and n != target["name"]:
                target[key].append(n)

    for p in result:
        p.setdefault("inverted_synonyms", [])
        p["synonyms"] = sorted(set(p["synonyms"]) - {p["name"]})
        if p["type"] == "boolean-rev":
            p["type"] = "boolean"
        del p["synonym_of_function"]
        del p["function"]
        # parametric templates such as "server reject md5 schannel:COMPUTERACCOUNT"
        if ":" in p["name"]:
            prefix, rest = p["name"].split(":", 1)
            p["template"] = {"prefix": prefix.strip(), "placeholder": rest.strip().upper()}
        for k in [k for k, v in p.items() if v in (None, [], False, "")]:
            if k not in ("doc", "default"):
                del p[k]
    # sanity: every related name should exist; drop the dangling ones
    names = {p["name"] for p in result}
    alias = {s for p in result for s in p.get("synonyms", []) + p.get("inverted_synonyms", [])}
    for p in result:
        if "related" in p:
            p["related"] = [r for r in p["related"] if r in names or r in alias]
            if not p["related"]:
                del p["related"]
    _ = by_name
    return sorted(result, key=lambda p: p["name"])


TYPE_HINTS = [
    (re.compile(r"^(BOOL|BOOLEAN|yes\s*\|\s*no|no\s*\|\s*yes)$", re.I), "boolean"),
    (re.compile(r"^(MODE|OCTAL|PERMISSIONS)$", re.I), "octal"),
    (re.compile(r"^(BYTES|SIZE|NUM|NUMBER|INTEGER|INT|SECONDS|TIMEOUT|COUNT|[0-9]+)$", re.I), "integer"),
    (re.compile(r"^(LIST|PATTERN LIST|STRING LIST|.*LIST)$", re.I), "list"),
]


def option_type(hint: str):
    hint = hint.strip()
    m = re.match(r"^\[\s*(.*?)\s*\]$", hint)
    if m and "|" in m.group(1):
        values = [v.strip() for v in m.group(1).split("|") if v.strip()]
        if {v.lower() for v in values} <= {"yes", "no", "true", "false"}:
            return "boolean", None
        return "enum", [{"value": v} for v in values]
    if "|" in hint and len(hint) < 80:
        values = [v.strip() for v in hint.split("|") if v.strip()]
        if {v.lower() for v in values} <= {"yes", "no", "true", "false"}:
            return "boolean", None
        if all(re.match(r"^[\w.-]+$", v) for v in values):
            return "enum", [{"value": v} for v in values]
    if re.match(r"^\w+(\s*/\s*\w+)+$", hint):
        values = [v.strip() for v in hint.split("/")]
        if {v.lower() for v in values} <= {"yes", "no", "true", "false"}:
            return "boolean", None
        return "enum", [{"value": v} for v in values]
    for rx, t in TYPE_HINTS:
        if rx.match(hint):
            return t, None
    return "string", None


def parse_vfs_modules(src: pathlib.Path):
    modules = []
    for f in sorted((src / "docs-xml" / "manpages").glob("vfs_*.8.xml")):
        tree = ET.fromstring(preprocess(f.read_text(encoding="iso-8859-1")))
        ref = tree.find("refentry")
        if ref is None:
            continue
        name = (ref.findtext("refnamediv/refname") or f.name.split(".")[0]).strip()
        module = name[4:] if name.startswith("vfs_") else name
        purpose = squash(ref.findtext("refnamediv/refpurpose") or "").strip()
        entry = {"name": module, "summary": purpose, "options": []}
        for sect in ref.findall("refsect1"):
            title = (sect.findtext("title") or "").strip().upper()
            if title == "DESCRIPTION":
                body = ET.Element("root")
                body.extend([c for c in sect if c.tag != "title"])
                text = tidy_html(to_html(body))
                entry["doc"] = text
                entry["stackable"] = "is stackable" in text and "not stackable" not in text
            elif title == "OPTIONS":
                for vle in sect.iter("varlistentry"):
                    term_el = vle.find("term")
                    if term_el is None:
                        continue
                    term = squash("".join(term_el.itertext())).strip()
                    m = re.match(r"^([\w-]+)\s*:\s*([^=]+?)\s*(?:=\s*(.*))?$", term)
                    if not m:
                        continue
                    optname = f"{m.group(1).lower()}:{m.group(2).strip()}"
                    hint = (m.group(3) or "").strip()
                    otype, values = option_type(hint)
                    li = vle.find("listitem")
                    doc = ""
                    if li is not None:
                        inner = ET.Element("listitem_inner")
                        inner.text = li.text
                        inner.extend(list(li))
                        doc = tidy_html(to_html(inner))
                    opt = {"name": optname, "hint": hint, "type": otype, "doc": doc}
                    if values:
                        opt["enum"] = values
                    dm = re.search(r"(?:default(?: value)? (?:is|of|to)|defaults to)\s*(?:<code>)?\s*&quot;?“?([\w./:+-]+)", doc, re.I)
                    if dm:
                        opt["default_hint"] = dm.group(1)
                    if not any(o["name"] == optname for o in entry["options"]):
                        entry["options"].append(opt)
        modules.append(entry)
    return modules


def parse_substitutions(src: pathlib.Path):
    text = (src / "docs-xml" / "manpages" / "smb.conf.5.xml").read_text(encoding="iso-8859-1")
    tree = ET.fromstring(preprocess(text))
    subs = []
    for sect in tree.iter("refsect1"):
        if (sect.findtext("title") or "").strip().upper() != "VARIABLE SUBSTITUTIONS":
            continue
        for vle in sect.iter("varlistentry"):
            term = squash("".join(vle.find("term").itertext())).strip()
            li = vle.find("listitem")
            inner = ET.Element("listitem_inner")
            inner.text = li.text
            inner.extend(list(li))
            subs.append({"name": term, "doc": tidy_html(to_html(inner))})
        break
    return subs


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    src = pathlib.Path(sys.argv[1])
    version = sys.argv[2]
    out = pathlib.Path(sys.argv[3])

    enums = parse_enums((src / "lib" / "param" / "param_table.c").read_text(encoding="utf-8"))
    params = resolve_synonyms(parse_parameters(src, enums))
    catalog = {
        "samba_version": version,
        "parameters": params,
        "vfs_modules": parse_vfs_modules(src),
        "substitutions": parse_substitutions(src),
    }
    out.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{out}: {len(params)} parameters, {len(catalog['vfs_modules'])} VFS modules, "
          f"{sum(len(m['options']) for m in catalog['vfs_modules'])} VFS options, "
          f"{len(catalog['substitutions'])} substitutions")


if __name__ == "__main__":
    main()
