// SPDX-License-Identifier: LGPL-2.1-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    parseTestparmDiagnostics, parsePdbeditVerbose, parsePdbeditList, parseSmbstatusJson, parseSmbstatusText,
    parseBuildOptions, parseSambaVersion, versionAtLeast, parsePasswd, parseGroup, parseStat, selinuxType,
} from "../../src/providers/smb/parsers.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(here, "fixtures", name), "utf8");

test("testparm diagnostics", () => {
    const ok = parseTestparmDiagnostics([
        "Load smb config files from /dev/stdin",
        "Unknown parameter encountered: \"foo bar\"",
        "Ignoring unknown parameter \"foo bar\"",
        "Loaded services file OK.",
        "Weak crypto is allowed by GnuTLS (e.g. NTLM as a compatibility fallback)",
        "",
        "WARNING: No path in service a - making it unavailable!",
        "NOTE: Service a is flagged unavailable.",
        "Server role: ROLE_STANDALONE",
    ].join("\n"), 0);
    assert.deepEqual(ok, [
        { level: "warning", message: "Unknown parameter encountered: \"foo bar\"" },
        { level: "warning", message: "No path in service a - making it unavailable!" },
        { level: "info", message: "Service a is flagged unavailable." },
    ]);
    const bad = parseTestparmDiagnostics("Load smb config files from x\nset_variable_helper(maybe): value is not boolean!\nError loading services.\n", 1);
    assert.equal(bad.filter(d => d.level === "error").length, 2);
    assert.deepEqual(parseTestparmDiagnostics("", 1), [{ level: "error", message: "testparm failed" }]);
});

test("pdbedit -L -v", () => {
    const users = parsePdbeditVerbose(fixture("pdbedit-v.txt"));
    assert.equal(users.length, 2);
    assert.equal(users[0].name, "alice");
    assert.equal(users[0].fullName, "Alice Martin");
    assert.equal(users[0].disabled, false);
    assert.equal(users[0].passwordLastSet, Date.UTC(2026, 10, 19, 15, 20) / 1000);
    assert.equal(users[1].disabled, true);
    assert.equal(users[1].passwordNeverExpires, true);
    assert.equal(users[1].passwordLastSet, null);
    assert.equal(users[1].badPasswordCount, 3);
    assert.deepEqual(parsePdbeditVerbose(""), []);
    assert.deepEqual(parsePdbeditList("nobody:65534:nobody\nalice:1000:Alice: the first\n"),
                     [{ name: "nobody", uid: 65534, fullName: "nobody" }, { name: "alice", uid: 1000, fullName: "Alice: the first" }]);
});

test("smbstatus --json from a real smbd", () => {
    const status = parseSmbstatusJson(fixture("smbstatus.json"));
    assert.match(status.version, /^4\./);
    assert.equal(status.sessions.length, 1);
    assert.equal(status.sessions[0].username, "nobody");
    assert.equal(status.sessions[0].dialect, "SMB3_11");
    assert.equal(status.sessions[0].signing?.degree, "partial");
    assert.equal(status.tcons.length, 1);
    assert.equal(status.tcons[0].service, "demo");
    assert.equal(status.tcons[0].pid, status.sessions[0].pid);
    assert.equal(status.openFiles.length, 1);
    assert.equal(status.openFiles[0].filename, "smb.conf");
    assert.equal(status.openFiles[0].access, "RW");
    assert.deepEqual(parseSmbstatusJson('{"sessions": {}, "tcons": {}, "open_files": {}}').sessions, []);
});

test("smbstatus text output (Samba < 4.16)", () => {
    const status = parseSmbstatusText(fixture("smbstatus-p.txt"), fixture("smbstatus-S.txt"));
    assert.equal(status.sessions.length, 1);
    assert.equal(status.sessions[0].username, "nobody");
    assert.equal(status.sessions[0].remoteMachine, "127.0.0.1");
    assert.match(status.sessions[0].hostname, /^ipv4:127\.0\.0\.1:\d+$/);
    assert.equal(status.sessions[0].dialect, "SMB3_11");
    assert.equal(status.sessions[0].encryption, null);
    assert.equal(status.sessions[0].signing?.cipher, "partial(AES-128-GMAC)");
    assert.equal(status.tcons.length, 1);
    assert.equal(status.tcons[0].service, "demo");
    assert.match(status.tcons[0].connectedAt, /2026 UTC$/);
});

test("smbd -b and versions", () => {
    const paths = parseBuildOptions(fixture("smbd-b.txt"));
    assert.equal(paths.CONFIGFILE, "/etc/samba/smb.conf");
    assert.equal(paths.LOCKDIR, "/run/samba");
    assert.deepEqual(parseSambaVersion("Version 4.19.5-Ubuntu"), [4, 19, 5]);
    assert.ok(versionAtLeast([4, 19, 5], 4, 16));
    assert.ok(!versionAtLeast([4, 15, 13], 4, 16));
    assert.ok(versionAtLeast([5, 0, 0], 4, 16));
});

test("passwd, group and stat", () => {
    assert.deepEqual(parsePasswd("root:x:0:0:root:/root:/bin/bash\nalice:x:1000:1000:Alice Martin,,,:/home/alice:/bin/bash\n")[1],
                     { name: "alice", uid: 1000, gid: 1000, gecos: "Alice Martin", home: "/home/alice", shell: "/bin/bash" });
    assert.deepEqual(parseGroup("staff:x:50:alice,bob\nempty:x:51:\n"),
                     [{ name: "staff", gid: 50, members: ["alice", "bob"] }, { name: "empty", gid: 51, members: [] }]);
    assert.deepEqual(parseStat("directory|root|staff|2775|unconfined_u:object_r:samba_share_t:s0\n"),
                     { exists: true, isDirectory: true, owner: "root", group: "staff", mode: "2775", selinuxContext: "unconfined_u:object_r:samba_share_t:s0" });
    assert.equal(parseStat("directory|root|root|755|?").selinuxContext, null);
    assert.equal(parseStat("").exists, false);
    assert.equal(selinuxType("system_u:object_r:samba_share_t:s0"), "samba_share_t");
});
