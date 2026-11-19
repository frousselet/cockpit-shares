// SPDX-License-Identifier: LGPL-2.1-or-later
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    SmbConf, parseBoolean, splitList, joinList, shareNameProblem, sameName, ValidationError,
} from "../../src/providers/smb/smbconf.ts";
import { catalogResolver, getParam, canonicalEnumValue, getVfsOption } from "../../src/providers/smb/catalog.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(here, "fixtures", name), "utf8");
const parse = (text: string) => SmbConf.parse(text, catalogResolver);

test("round trip is lossless on real files", () => {
    for (const name of ["debian-smb.conf", "samba-example-smb.conf"]) {
        const text = fixture(name);
        assert.equal(parse(text).toString(), text, name);
    }
    for (const text of ["", "\n", "[a]", "[a]\n\tpath = /x", "  # c\r\n[a]\r\npath=/x\r\n", "a = b\\\n c\n"])
        assert.equal(parse(text).toString(), text, JSON.stringify(text));
});

test("reads the Debian default configuration", () => {
    const conf = parse(fixture("debian-smb.conf"));
    assert.deepEqual(conf.sectionNames(), ["printers", "print$"]);
    assert.equal(conf.get("global", "workgroup"), "WORKGROUP");
    assert.equal(conf.get("global", "map to guest"), "bad user");
    assert.equal(conf.get("printers", "browseable"), "no");
    // commented out options are not parameters
    assert.equal(conf.get("global", "interfaces"), undefined);
    // values keep '#' and ';' characters, Samba has no trailing comments
    assert.match(conf.get("global", "passwd chat")!, /successfully\* \.$/);
});

test("names are compared ignoring case and whitespace", () => {
    const conf = parse("[Data]\n  ReadOnly = no\n  Guest  OK = yes\n  BROWSABLE = no\n");
    assert.equal(conf.get("data", "read only"), "no");
    assert.equal(conf.get("DATA", "guest ok"), "yes");
    assert.equal(conf.get("data", "browseable"), "no");
    assert.ok(sameName("print$", "PRINT $"));
    assert.ok(conf.hasSection(" d a t a "));
});

test("synonyms and inverted synonyms", () => {
    const conf = parse("[a]\n\twriteable = yes\n\tpublic = yes\n\tdirectory = /srv/a\n");
    const a = conf.section("a")!;
    assert.equal(a.parameters.get("read only")!.value, "no");
    assert.equal(a.parameters.get("read only")!.key, "writeable");
    assert.equal(a.parameters.get("guest ok")!.value, "yes");
    assert.equal(a.parameters.get("path")!.value, "/srv/a");
    // reading through a synonym inverts back
    assert.equal(conf.get("a", "writable"), "yes");

    // writing the canonical parameter rewrites the synonym line in place
    conf.set("a", "read only", "yes");
    assert.equal(conf.toString(), "[a]\n\tread only = yes\n\tpublic = yes\n\tdirectory = /srv/a\n");
    // writing through an inverted synonym inverts the value
    conf.set("a", "write ok", "yes");
    assert.equal(conf.get("a", "read only"), "no");
    // an unchanged, non inverted line is left alone (key spelling kept)
    conf.set("a", "path", "/srv/a");
    assert.match(conf.toString(), /\tdirectory = \/srv\/a/);
    conf.set("a", "path", "/srv/b");
    assert.match(conf.toString(), /\tpath = \/srv\/b/);
});

test("last occurrence wins, duplicated sections are merged", () => {
    const conf = parse("[a]\npath = /1\n[b]\npath = /b\n[A]\npath = /2\ncomment = x\n");
    assert.deepEqual(conf.sectionNames(), ["a", "b"]);
    assert.equal(conf.get("a", "path"), "/2");
    conf.set("a", "path", "/3");
    assert.equal(conf.toString(), "[a]\npath = /1\n[b]\npath = /b\n[A]\npath = /3\ncomment = x\n");
    assert.ok(conf.unset("a", "path"));
    assert.equal(conf.toString(), "[a]\n[b]\npath = /b\n[A]\ncomment = x\n");
});

test("parameters before the first section are global, [globals] is [global]", () => {
    const conf = parse("workgroup = HOME\n[globals]\nnetbios name = NAS\n[x]\npath=/x\n");
    assert.equal(conf.get("global", "workgroup"), "HOME");
    assert.equal(conf.get("global", "netbios name"), "NAS");
    assert.deepEqual(conf.sectionNames(), ["x"]);
});

test("continuation lines", () => {
    const text = "[a]\n\tvalid users = alice \\\n\t\tbob\\\n carol\n\tpath = /a\n";
    const conf = parse(text);
    assert.equal(conf.get("a", "valid users"), "alice bob carol");
    assert.equal(conf.toString(), text);
    conf.set("a", "valid users", "alice");
    assert.equal(conf.toString(), "[a]\n\tvalid users = alice\n\tpath = /a\n");
    // a comment ending with a backslash does not continue
    const c = parse("# foo \\\n[a]\npath = /a\n");
    assert.deepEqual(c.sectionNames(), ["a"]);
});

test("new parameters follow the house style", () => {
    const conf = parse(fixture("debian-smb.conf"));
    conf.set("print$", "comment", "Drivers");
    conf.set("print$", "guest ok", "yes");
    conf.set("print$", "hosts allow", "192.168.1.");
    const text = conf.toString();
    assert.match(text, /\n {3}comment = Drivers\n/);
    assert.match(text, /\n {3}guest ok = yes\n {3}hosts allow = 192\.168\.1\.\n/);
    // nothing else moved
    assert.equal(text.split("\n").length, fixture("debian-smb.conf").split("\n").length + 1);
});

test("adding a section and its parameters", () => {
    const conf = parse("[global]\n\tworkgroup = W\n");
    conf.addSection("data");
    conf.set("data", "path", "/srv/data");
    conf.set("data", "read only", "no");
    assert.equal(conf.toString(), "[global]\n\tworkgroup = W\n\n[data]\n\tpath = /srv/data\n\tread only = no\n");
    assert.throws(() => conf.addSection("DATA"), /already exists/);
    // set() creates the section when needed
    const empty = parse("");
    empty.set("x", "path", "/x");
    assert.equal(empty.toString(), "[x]\n\tpath = /x\n");
    // global is created before the first share
    const g = parse("[x]\n\tpath = /x\n");
    g.set("global", "workgroup", "W");
    assert.equal(g.toString(), "[global]\n\tworkgroup = W\n\n[x]\n\tpath = /x\n");
});

test("removing a section keeps the comments of its neighbours", () => {
    const text = [
        "[global]",
        "\tworkgroup = W",
        "",
        "# The data share",
        "[data]",
        "\tpath = /srv/data",
        ";\tread only = no",
        "",
        "# The music share",
        "[music]",
        "\tpath = /srv/music",
        "",
    ].join("\n");
    const conf = parse(text);
    conf.removeSection("data");
    assert.equal(conf.toString(), "[global]\n\tworkgroup = W\n\n# The music share\n[music]\n\tpath = /srv/music\n");
    const conf2 = parse(text);
    conf2.removeSection("music");
    assert.equal(conf2.toString(), "[global]\n\tworkgroup = W\n\n# The data share\n[data]\n\tpath = /srv/data\n;\tread only = no\n");
    // the Debian file: removing [printers] keeps the "print$" documentation
    const deb = parse(fixture("debian-smb.conf"));
    deb.removeSection("printers");
    assert.deepEqual(deb.sectionNames(), ["print$"]);
    assert.match(deb.toString(), /Windows clients look for this share name as a source of downloadable\n# printer drivers\n\[print\$\]/);
    assert.throws(() => deb.removeSection("global"));
});

test("renaming a section", () => {
    const conf = parse("[a] ; trailing\npath = /a\n[b]\n[A]\ncomment = c\n");
    conf.renameSection("a", "Archive");
    assert.equal(conf.toString(), "[Archive] ; trailing\npath = /a\n[b]\n[Archive]\ncomment = c\n");
    assert.throws(() => conf.renameSection("b", "archive"), /already exists/);
    conf.renameSection("archive", "ARCHIVE");
    assert.deepEqual(conf.sectionNames(), ["ARCHIVE", "b"]);
});

test("setSection replaces the whole parameter set", () => {
    const conf = parse("[a]\n\t# keep me\n\tpath = /a\n\tcomment = old\n\tbrowsable = no\n");
    conf.setSection("a", { path: "/a", comment: "new", "guest ok": "yes" });
    assert.equal(conf.toString(), "[a]\n\t# keep me\n\tpath = /a\n\tcomment = new\n\tguest ok = yes\n");
});

test("invalid values are refused", () => {
    const conf = parse("[a]\n");
    assert.throws(() => conf.set("a", "comment", "x\ny"), ValidationError);
    assert.throws(() => conf.set("a", "comment", "ends with \\"), ValidationError);
    assert.throws(() => conf.addSection("a]b"), ValidationError);
});

test("booleans follow set_boolean()", () => {
    for (const v of ["yes", "Yes", "TRUE", "on", "1", " y e s "])
        assert.equal(parseBoolean(v), true, v);
    for (const v of ["no", "False", "off", "0"])
        assert.equal(parseBoolean(v), false, v);
    assert.equal(parseBoolean("auto"), null);
});

test("lists", () => {
    assert.deepEqual(splitList("alice, bob  @staff"), ["alice", "bob", "@staff"]);
    assert.deepEqual(splitList('@"DOM\\Domain Users" "two words",x'), ["@DOM\\Domain Users", "two words", "x"]);
    assert.equal(joinList(["alice", "@DOM\\Domain Users"]), 'alice "@DOM\\Domain Users"');
    assert.deepEqual(splitList(""), []);
});

test("share names", () => {
    assert.equal(shareNameProblem("data"), null);
    assert.equal(shareNameProblem("print$"), null);
    assert.equal(shareNameProblem("Mes documents"), null);
    assert.equal(shareNameProblem(" x"), "spaces");
    assert.equal(shareNameProblem("a]b"), "brackets");
    assert.equal(shareNameProblem("a/b"), "reserved");
    assert.equal(shareNameProblem("Global"), "global");
    assert.equal(shareNameProblem(""), "empty");
});

test("catalog lookups", () => {
    assert.equal(getParam("writable")!.name, "read only");
    assert.equal(getParam("Browsable")!.name, "browseable");
    assert.equal(getParam("read only")!.context, "S");
    assert.equal(getParam("workgroup")!.context, "G");
    assert.equal(canonicalEnumValue(getParam("map to guest")!, "bad user"), "Bad User");
    assert.equal(canonicalEnumValue(getParam("server smb encrypt")!, "mandatory"), "required");
    assert.equal(canonicalEnumValue(getParam("server min protocol")!, "smb3_11"), "SMB3");
    assert.equal(getVfsOption("FRUIT : Time Machine")!.module.name, "fruit");
    assert.equal(catalogResolver("fruit : time machine").name, "fruit:time machine");
    assert.equal(catalogResolver("acme:Some Option").name, "acme:some option");
});

// Cross check with Samba itself when testparm is installed: every value
// reported by testparm must be the one our parser computes.
import { execFileSync } from "node:child_process";
import os from "node:os";

function haveTestparm(): boolean {
    try {
        execFileSync("testparm", ["--version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function normalizeValue(name: string, value: string): string {
    const def = getParam(name);
    if (def?.type === "boolean") {
        const b = parseBoolean(value);
        return b === null ? value : String(b);
    }
    if (def?.enum)
        return canonicalEnumValue(def, value) ?? value;
    if (def?.type === "list" || def?.type === "cmdlist")
        return splitList(value).join(" ");
    return value.replace(/\s+/g, " ").trim();
}

test("our reading matches testparm", { skip: !haveTestparm() && "testparm not installed" }, () => {
    const tricky = [
        "workgroup = EARLY",
        "[global]",
        "\tnetbios name = NAS",
        "\tserver string = %h \\",
        "\t\tserver",
        "[Data]",
        "\tdirectory = /srv/data",
        "\twriteable = yes",
        "\tPublic = yes",
        "\tvalid users = alice, bob \\",
        "\t\t@staff",
        "\tcomment = semicolon ; and # hash",
        "[other]",
        "\tpath = /srv/other",
        "\tread only = on",
        "[data]",
        "\tbrowsable = no",
        "\tpath = /srv/data2",
        "",
    ].join("\n");
    const files: [string, string][] = [
        ["tricky", tricky],
        ["debian", fixture("debian-smb.conf")],
        ["example", fixture("samba-example-smb.conf")],
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smbconf-test-"));
    try {
        for (const [label, text] of files) {
            const file = path.join(dir, `${label}.conf`);
            fs.writeFileSync(file, text);
            const out = execFileSync("testparm", ["-s", "--suppress-prompt", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
            const theirs = parse(out);
            const ours = parse(text);
            assert.deepEqual(ours.sectionNames().map(s => s.toLowerCase()), theirs.sectionNames().map(s => s.toLowerCase()), label);
            for (const section of ["global", ...theirs.sectionNames()]) {
                for (const [name, p] of theirs.section(section)!.parameters) {
                    const mine = ours.get(section, name);
                    // testparm also prints values inherited from [global] in no case, so every
                    // printed share value must come from the file
                    if (mine === undefined && section === "global")
                        continue; // defaults changed by the server role, e.g. "idmap config * : backend"
                    assert.equal(normalizeValue(name, mine ?? "<missing>"), normalizeValue(name, p.value), `${label} [${section}] ${name}`);
                }
            }
        }
        const t = parse(tricky);
        assert.equal(t.get("data", "path"), "/srv/data2");
        assert.equal(t.get("data", "read only"), "no");
        assert.equal(t.get("global", "workgroup"), "EARLY");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
