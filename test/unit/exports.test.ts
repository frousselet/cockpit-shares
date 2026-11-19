// SPDX-License-Identifier: LGPL-2.1-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    ExportsFile, parseEntry, serializeEntry, encodePath, decodePath, effectiveOptions, resolveOptions,
    parseExportfsVerbose, parseClientInfo, hostProblem, type ClientItem,
} from "../../src/providers/nfs/exports.ts";

const UBUNTU_DEFAULT = `# /etc/exports: the access control list for filesystems which may be exported
#\t\tto NFS clients.  See exports(5).
#
# Example for NFSv2 and NFSv3:
# /srv/homes       hostname1(rw,sync,no_subtree_check) hostname2(ro,sync,no_subtree_check)
#
# Example for NFSv4:
# /srv/nfs4        gss/krb5i(rw,sync,fsid=0,crossmnt,no_subtree_check)
# /srv/nfs4/homes  gss/krb5i(rw,sync,no_subtree_check)
#
`;

// the example of exports(5)
const MAN_EXAMPLE = `# sample /etc/exports file
/               master(rw) trusty(rw,no_root_squash)
/projects       proj*.local.domain(rw)
/usr            *.local.domain(ro) @trusted(rw)
/home/joe       pc001(rw,all_squash,anonuid=150,anongid=100)
/pub            *(ro,insecure,all_squash)
/srv/www        -sync,rw server @trusted @external(ro)
/foo            2001:db8:9:e54::/64(rw) 192.0.2.0/24(rw)
/build          buildhost[0-9].local.domain(rw)
`;

test("round trip is lossless", () => {
    for (const text of [UBUNTU_DEFAULT, MAN_EXAMPLE, "", "\n", "/a *(rw)", "  /a  h1(rw)   h2 # c\n", "/a h1(rw) \\\n\th2(ro)\n"])
        assert.equal(ExportsFile.parse(text).toString(), text, JSON.stringify(text));
});

test("the Ubuntu default file has no entry", () => {
    assert.deepEqual(ExportsFile.parse(UBUNTU_DEFAULT).entries(), []);
});

test("the exports(5) example", () => {
    const entries = ExportsFile.parse(MAN_EXAMPLE).entries().map(e => e.entry);
    assert.equal(entries.length, 8);
    assert.equal(entries[0].path, "/");
    assert.deepEqual(entries[0].items, [
        { kind: "client", host: "master", options: ["rw"] },
        { kind: "client", host: "trusty", options: ["rw", "no_root_squash"] },
    ]);
    const www = entries[5];
    assert.deepEqual(www.items[0], { kind: "defaults", options: ["sync", "rw"] });
    assert.deepEqual(effectiveOptions(www, 1), ["sync", "rw"]);
    assert.deepEqual(effectiveOptions(www, 3), ["sync", "rw", "ro"]);
    assert.equal((entries[6].items[0] as ClientItem).host, "2001:db8:9:e54::/64");
    assert.equal((entries[7].items[0] as ClientItem).host, "buildhost[0-9].local.domain");
});

test("comments, continuations and quoting", () => {
    const f = ExportsFile.parse('"/srv/my share" 10.0.0.0/8(rw) # team\n/srv/a\\040b host(ro)\n/srv/c h1(rw) \\\n  h2(ro)\n');
    const e = f.entries().map(x => x.entry);
    assert.equal(e[0].path, "/srv/my share");
    assert.equal(e[0].comment, "# team");
    assert.equal(e[1].path, "/srv/a b");
    assert.deepEqual(e[2].items.map(i => (i as ClientItem).host), ["h1", "h2"]);
    // '#' inside quotes is part of the path
    assert.equal(parseEntry('"/srv/#1" *(ro)').entry!.path, "/srv/#1");
});

test("the blank before options is reported", () => {
    const { entry, problems } = parseEntry("/srv/a host (rw)");
    assert.deepEqual(entry!.items, [{ kind: "client", host: "host", options: [] }, { kind: "client", host: "", options: ["rw"] }]);
    assert.equal(problems.length, 1);
    // rewriting makes the meaning explicit
    assert.equal(serializeEntry(entry!), "/srv/a host *(rw)");
    assert.equal(parseEntry("/srv/a").problems.length, 1);
});

test("paths are encoded so that exportfs reads them back", () => {
    for (const p of ["/srv/a", "/srv/my share", "/srv/a#b", '/srv/q"uote', "/srv/back\\slash", "/srv/tab\tx"])
        assert.equal(decodePath(encodePath(p)), p, p);
    assert.equal(encodePath("/srv/my share"), '"/srv/my share"');
    assert.equal(encodePath("/srv/a#b"), "/srv/a\\043b");
});

test("editing keeps the other lines", () => {
    const f = ExportsFile.parse(UBUNTU_DEFAULT + "/srv/a *(ro) # keep\n\n/srv/b h(rw)\n");
    const i = f.find("/srv/a");
    const e = f.lines[i].entry!;
    f.replace(i, { ...e, items: [{ kind: "client", host: "10.0.0.0/8", options: ["rw", "sync", "no_subtree_check"] }] });
    f.add({ path: "/srv/new dir", items: [{ kind: "client", host: "*", options: ["ro"] }], comment: "" });
    f.remove(f.find("/srv/b"));
    assert.equal(f.toString(), UBUNTU_DEFAULT + '/srv/a 10.0.0.0/8(rw,sync,no_subtree_check) # keep\n\n"/srv/new dir" *(ro)\n');
    assert.equal(f.find("/srv/b"), -1);
    assert.throws(() => f.remove(0));
});

test("conflicting options: the last one wins", () => {
    assert.deepEqual(resolveOptions(["sync", "rw", "ro"]), ["sync", "ro"]);
    assert.deepEqual(resolveOptions(["anonuid=1", "insecure_locks", "anonuid=2", "auth_nlm"]), ["anonuid=2", "auth_nlm"]);
    assert.deepEqual(resolveOptions(["sec=krb5", "rw", "sec=sys", "ro"]), ["sec=krb5", "rw", "sec=sys", "ro"]);
});

test("exportfs -v output", () => {
    const out = [
        "/srv/a-very-long-directory-name-for-testing-the-output-format",
        "\t\t10.1.1.1(sync,wdelay,hide,no_subtree_check,sec=sys,rw,root_squash,no_all_squash)",
        "/srv/nfs-a    \t<world>(sync,wdelay,hide,no_subtree_check,sec=krb5p:sys,ro,root_squash,no_all_squash)",
        "/srv/a\\040b   \t10.0.0.3(sync,ro)",
        "/srv/my share",
        "\t\t10.3.0.1(sync,rw)",
        "/srv/x y\t<world>(ro)",
        "",
    ].join("\n");
    assert.deepEqual(parseExportfsVerbose(out), [
        { path: "/srv/a-very-long-directory-name-for-testing-the-output-format", client: "10.1.1.1", options: ["sync", "wdelay", "hide", "no_subtree_check", "sec=sys", "rw", "root_squash", "no_all_squash"] },
        { path: "/srv/nfs-a", client: "*", options: ["sync", "wdelay", "hide", "no_subtree_check", "sec=krb5p:sys", "ro", "root_squash", "no_all_squash"] },
        { path: "/srv/a b", client: "10.0.0.3", options: ["sync", "ro"] },
        { path: "/srv/my share", client: "10.3.0.1", options: ["sync", "rw"] },
        { path: "/srv/x y", client: "*", options: ["ro"] },
    ]);
});

test("client information", () => {
    const c = parseClientInfo("3", 'clientid: 0x6763b7f2f5a1d0e6\naddress: "192.168.1.20:875"\nstatus: confirmed\nseconds from last renew: 12\nname: "Linux NFSv4.2 laptop"\nminor version: 2\nImplementation domain: "kernel.org"\nImplementation name: "Linux 6.8.0 #1 SMP x86_64"\n');
    assert.equal(c.address, "192.168.1.20:875");
    assert.equal(c.name, "Linux NFSv4.2 laptop");
    assert.equal(c.minorVersion, 2);
    assert.equal(c.status, "confirmed");
    assert.match(c.implementation, /^kernel\.org Linux/);
});

test("host checks", () => {
    for (const h of ["*", "10.0.0.0/8", "host.example.com", "*.example.com", "@trusted", "2001:db8::/64", "gss/krb5"])
        assert.equal(hostProblem(h), null, h);
    for (const h of ["", "a b", "a(b", "-x"])
        assert.notEqual(hostProblem(h), null, h);
});

// Cross check with exportfs itself, in a private mount namespace so that the
// real /etc/exports and /var/lib/nfs are not touched (root only).
function canRunExportfs(): boolean {
    try {
        execFileSync("unshare", ["--mount", "true"], { stdio: "ignore" });
        execFileSync("sh", ["-c", "command -v exportfs"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

test("our reading matches exportfs", { skip: !canRunExportfs() && "needs root, unshare and exportfs" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exports-test-"));
    try {
        fs.mkdirSync(path.join(dir, "state"));
        for (const d of ["a", "my share", "c"])
            fs.mkdirSync(path.join(dir, d));
        const text = [
            `${dir}/a 10.1.0.0/16(rw,no_subtree_check) 10.2.0.1(ro,no_subtree_check)  # comment`,
            `"${dir}/my share" -rw,no_subtree_check 10.3.0.1 10.3.0.2(ro)`,
            `${dir}/c 10.4.0.1(rw,no_subtree_check) \\`,
            `    10.4.0.2(ro,no_subtree_check,all_squash,anonuid=150)`,
            "",
        ].join("\n");
        fs.writeFileSync(path.join(dir, "exports"), text);
        const out = execFileSync("unshare", ["--mount", "sh", "-c",
            `mount --bind "$1/exports" /etc/exports && mount --bind "$1/state" /var/lib/nfs && exportfs -ra 2>/dev/null; exportfs -v`, "--", dir],
                                 { encoding: "utf8" });
        const active = parseExportfsVerbose(out);
        const ours = ExportsFile.parse(text).entries();
        let count = 0;
        for (const { entry } of ours) {
            entry.items.forEach((item, i) => {
                if (item.kind !== "client")
                    return;
                count++;
                const a = active.find(x => x.path === entry.path && x.client === item.host);
                assert.ok(a, `${entry.path} ${item.host} exported`);
                for (const o of resolveOptions(effectiveOptions(entry, i)))
                    assert.ok(a.options.includes(o), `${entry.path} ${item.host}: ${o} in ${a.options.join(",")}`);
            });
        }
        assert.equal(count, 6);
        assert.equal(active.length, 6);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

import { parseExportfsDiagnostics, parseNfsConfDump } from "../../src/providers/nfs/parsers.ts";

test("exportfs diagnostics", () => {
    const d = parseExportfsDiagnostics([
        "exportfs: /etc/exports [1]: Neither 'subtree_check' or 'no_subtree_check' specified for export \"*:/srv/nfs-a\".",
        "  Assuming default behaviour ('no_subtree_check').",
        "  NOTE: this default has changed since nfs-utils version 1.0.x",
        "",
        "exportfs: Failed to resolve host1",
        "exportfs: Failed to resolve host1",
        "exportfs: /etc/exports:4: unknown keyword \"foo\"",
        "",
        "exportfs: Failed to stat /srv/missing: No such file or directory",
    ].join("\n"));
    assert.deepEqual(d.map(x => x.level), ["info", "warning", "error", "warning"]);
    assert.match(d[0].message, /Assuming default behaviour/);
    assert.equal(d[2].message, '/etc/exports:4: unknown keyword "foo"');
});

test("nfsconf --dump", () => {
    const conf = parseNfsConfDump("[general]\n pipefs-directory = /run/rpc_pipefs\n\n[mountd]\n manage-gids = y\n[nfsd]\n threads = 16\n vers4.2 = n\n");
    assert.equal(conf.get("mountd")!.get("manage-gids"), "y");
    assert.equal(conf.get("nfsd")!.get("threads"), "16");
    assert.equal(conf.get("nfsd")!.get("vers4.2"), "n");
});
