/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Everything that touches the system for the SMB provider: Samba tools,
 * smb.conf, systemd units, SELinux. All privileged operations go through the
 * Cockpit bridge with superuser "require", reads use "try".
 */

import cockpit from "cockpit";

import { SmbConf } from "./smbconf.ts";
import { catalogResolver } from "./catalog.ts";
import {
    parseTestparmDiagnostics, parsePdbeditVerbose, parseSmbstatusJson, parseSmbstatusText,
    parseSambaVersion, versionAtLeast, parseStat, type Diagnostic, type SambaUser, type SmbStatus, type PathInfo,
} from "./parsers.ts";

import {
    run, script, writeConfigFile, CommandError, ConflictError, createDirectory, readFile, BACKUP_DIR,
} from "../../lib/system.ts";

export { run, CommandError, ConflictError, createDirectory, readFile, BACKUP_DIR };

const _ = cockpit.gettext;

export interface SmbEnvironment {
    installed: boolean;
    tools: Record<string, boolean>;
    version: number[] | null;
    versionString: string;
    configFile: string;
    selinux: "enforcing" | "permissive" | "disabled";
    units: {
        smbd: string | null;
        nmbd: string | null;
        winbind: string | null;
        addc: string | null;
        wsdd: string | null;
    };
}

const DETECT_SCRIPT = `
for t in testparm smbd nmbd pdbedit smbpasswd smbstatus smbcontrol net semanage restorecon chcon getsebool setsebool; do
    if command -v "$t" >/dev/null 2>&1; then echo "tool.$t=1"; fi
done
if command -v smbd >/dev/null 2>&1; then
    smbd -V 2>/dev/null | sed 's/^/version=/'
    smbd -b 2>/dev/null | sed -n 's/^ *CONFIGFILE: */configfile=/p'
elif command -v testparm >/dev/null 2>&1; then
    testparm --version 2>/dev/null | sed 's/^/version=/'
fi
if [ -r /sys/fs/selinux/enforce ]; then echo "selinux=$(cat /sys/fs/selinux/enforce)"; fi
for u in smb smbd nmb nmbd winbind samba-ad-dc wsdd wsdd2; do
    for d in /etc/systemd/system /run/systemd/system /usr/local/lib/systemd/system /usr/lib/systemd/system /lib/systemd/system; do
        if [ -e "$d/$u.service" ] && [ "$(readlink -f "$d/$u.service")" != /dev/null ]; then
            echo "unit.$u=$(basename "$(readlink -f "$d/$u.service")" .service)"; break
        fi
    done
done
`;

export async function detectEnvironment(): Promise<SmbEnvironment> {
    const out = await script(DETECT_SCRIPT, [], { superuser: "try" });
    const kv: Record<string, string> = {};
    for (const line of out.split("\n")) {
        const i = line.indexOf("=");
        if (i > 0)
            kv[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    const tools: Record<string, boolean> = {};
    for (const k of Object.keys(kv))
        if (k.startsWith("tool."))
            tools[k.slice(5)] = true;
    // aliases such as smb.service -> smbd.service resolve to the real unit
    const unit = (...names: string[]) => {
        const found = names.find(n => kv["unit." + n]);
        return found ? kv["unit." + found] : null;
    };
    const selinux = kv.selinux === "1" ? "enforcing" : kv.selinux === "0" ? "permissive" : "disabled";
    return {
        installed: !!tools.testparm && !!tools.smbd,
        tools,
        version: parseSambaVersion(kv.version ?? ""),
        versionString: (kv.version ?? "").replace(/^Version\s+/, ""),
        configFile: kv.configfile || "/etc/samba/smb.conf",
        selinux,
        units: {
            smbd: unit("smb", "smbd"),
            nmbd: unit("nmb", "nmbd"),
            winbind: unit("winbind"),
            addc: unit("samba-ad-dc"),
            wsdd: unit("wsdd", "wsdd2"),
        },
    };
}

/* === testparm ================================================== */

export interface TestparmResult {
    ok: boolean;
    diagnostics: Diagnostic[];
    /** testparm's own dump of the configuration */
    dump: SmbConf | null;
}

const TESTPARM_SCRIPT = `
out=$(mktemp) || exit 1
err=$(mktemp) || exit 1
testparm -s --suppress-prompt "$@" >"$out" 2>"$err"
rc=$?
echo "rc=$rc"
echo "--stderr--"
cat "$err"
echo "--stdout--"
cat "$out"
rm -f "$out" "$err"
`;

/**
 * Run testparm. With `text`, the candidate configuration is fed on stdin so
 * that nothing is written before it was validated.
 */
export async function testparm(options: { text?: string, file?: string, verbose?: boolean } = {}): Promise<TestparmResult> {
    const args = [];
    if (options.verbose)
        args.push("-v");
    args.push(options.text !== undefined ? "/dev/stdin" : (options.file ?? ""));
    const out = await script(TESTPARM_SCRIPT, args.filter(Boolean), { superuser: "try", input: options.text ?? "" });
    const m = out.match(/^rc=(\d+)\n--stderr--\n([\s\S]*?)--stdout--\n([\s\S]*)$/);
    if (!m)
        throw new CommandError(_("Unexpected output of testparm"), out);
    const rc = Number(m[1]);
    const diagnostics = parseTestparmDiagnostics(m[2], rc);
    return { ok: rc === 0, diagnostics, dump: rc === 0 ? SmbConf.parse(m[3], catalogResolver) : null };
}

/** Built-in defaults of the installed Samba version (empty configuration). */
export async function builtinDefaults(): Promise<Map<string, string>> {
    const result = await testparm({ text: "[global]\n", verbose: true });
    return new Map(Array.from(result.dump?.section("global")?.parameters ?? []).map(([k, p]) => [k, p.value]));
}

/* === configuration file ======================================== */

export class ValidationFailed extends Error {
    diagnostics: Diagnostic[];
    constructor(diagnostics: Diagnostic[]) {
        super(_("The configuration is not valid"));
        this.diagnostics = diagnostics;
    }
}

export interface SaveResult {
    tag: string;
    diagnostics: Diagnostic[];
    reloaded: boolean;
}

/**
 * Validate, back up, write and apply a new smb.conf.
 * `tag` is the tag of the version the change was based on; the write fails
 * with ConflictError when the file changed on disk in the meantime.
 */
export async function saveConfig(env: SmbEnvironment, text: string, tag: string | null): Promise<SaveResult> {
    const check = await testparm({ text });
    if (!check.ok)
        throw new ValidationFailed(check.diagnostics);

    const newTag = await writeConfigFile(env.configFile, text, tag);
    const reloaded = await reloadConfig();
    return { tag: newTag, diagnostics: check.diagnostics, reloaded };
}

/** Ask every running Samba daemon to reread its configuration. */
export async function reloadConfig(): Promise<boolean> {
    try {
        await run(["smbcontrol", "all", "reload-config"], { superuser: "require" });
        return true;
    } catch {
        // nothing is running, the new configuration is used on next start
        return false;
    }
}

/* === Samba users =============================================== */

export async function listSambaUsers(): Promise<SambaUser[]> {
    return parsePdbeditVerbose(await run(["pdbedit", "-L", "-v"], { superuser: "require" }));
}

export async function addSambaUser(name: string, password: string): Promise<void> {
    await run(["smbpasswd", "-a", "-s", "--", name], { superuser: "require", input: `${password}\n${password}\n` });
}

export async function setSambaPassword(name: string, password: string): Promise<void> {
    await run(["smbpasswd", "-s", "--", name], { superuser: "require", input: `${password}\n${password}\n` });
}

export async function setSambaUserEnabled(name: string, enabled: boolean): Promise<void> {
    await run(["smbpasswd", enabled ? "-e" : "-d", "--", name], { superuser: "require" });
}

export async function deleteSambaUser(name: string): Promise<void> {
    await run(["smbpasswd", "-x", "--", name], { superuser: "require" });
}

/* === status ==================================================== */

export async function getStatus(env: SmbEnvironment): Promise<SmbStatus> {
    if (versionAtLeast(env.version, 4, 16))
        return parseSmbstatusJson(await run(["smbstatus", "--json"], { superuser: "require" }));
    const [processes, shares] = await Promise.all([
        run(["smbstatus", "-p"], { superuser: "require" }),
        run(["smbstatus", "-S"], { superuser: "require" }),
    ]);
    return parseSmbstatusText(processes, shares);
}

export async function disconnectProcess(pid: string): Promise<void> {
    if (!/^\d+$/.test(pid))
        throw new Error("invalid pid");
    await run(["kill", "-TERM", pid], { superuser: "require" });
}

export async function closeShare(name: string): Promise<void> {
    await run(["smbcontrol", "smbd", "close-share", name], { superuser: "require" });
}

/* === paths and SELinux ========================================= */

export async function statPath(path: string, env: SmbEnvironment): Promise<PathInfo> {
    let out = "";
    try {
        out = await run(["stat", "-L", "-c", "%F|%U|%G|%a", "--", path], { superuser: "try" });
    } catch {
        return parseStat("");
    }
    let context = "?";
    if (env.selinux !== "disabled") {
        try {
            context = (await run(["stat", "-L", "-c", "%C", "--", path], { superuser: "try" })).trim();
        } catch {
            context = "?";
        }
    }
    return parseStat(`${out.trim()}|${context}`);
}

export async function getSelinuxBooleans(names: string[]): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {};
    try {
        const out = await run(["getsebool", ...names], { superuser: "try" });
        for (const line of out.split("\n")) {
            const m = line.match(/^(\S+)\s+-->\s+(on|off)$/);
            if (m)
                result[m[1]] = m[2] === "on";
        }
    } catch {
        // policy without these booleans
    }
    return result;
}

function regexEscape(path: string): string {
    return path.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/** Label a directory tree samba_share_t, persistently when semanage is available. */
export async function labelForSamba(path: string, env: SmbEnvironment): Promise<"persistent" | "temporary"> {
    const spec = `${regexEscape(path.replace(/\/+$/, ""))}(/.*)?`;
    if (env.tools.semanage && env.tools.restorecon) {
        try {
            await run(["semanage", "fcontext", "-a", "-t", "samba_share_t", spec], { superuser: "require" });
        } catch {
            // a rule for this path exists already: modify it
            await run(["semanage", "fcontext", "-m", "-t", "samba_share_t", spec], { superuser: "require" });
        }
        await run(["restorecon", "-R", "--", path], { superuser: "require" });
        return "persistent";
    }
    await run(["chcon", "-R", "-t", "samba_share_t", "--", path], { superuser: "require" });
    return "temporary";
}

/* === system accounts =========================================== */

export async function readPasswdAndGroups(): Promise<{ passwd: string, group: string }> {
    // getent also lists directory (LDAP, SSSD, winbind) accounts when enumeration is enabled
    const get = async (db: string, file: string) => {
        try {
            return await run(["getent", db]);
        } catch {
            const handle = cockpit.file(file);
            try {
                return (await handle.read()) ?? "";
            } finally {
                handle.close();
            }
        }
    };
    const [passwd, group] = await Promise.all([get("passwd", "/etc/passwd"), get("group", "/etc/group")]);
    return { passwd, group };
}

export async function readLoginDefs(): Promise<{ uidMin: number, uidMax: number }> {
    const handle = cockpit.file("/etc/login.defs");
    let text = "";
    try {
        text = (await handle.read()) ?? "";
    } catch {
        text = "";
    } finally {
        handle.close();
    }
    const get = (key: string, fallback: number) => {
        const m = text.match(new RegExp(`^\\s*${key}\\s+(\\d+)`, "m"));
        return m ? Number(m[1]) : fallback;
    };
    return { uidMin: get("UID_MIN", 1000), uidMax: get("UID_MAX", 60000) };
}

export async function setSelinuxBoolean(name: string, on: boolean): Promise<void> {
    await run(["setsebool", "-P", name, on ? "on" : "off"], { superuser: "require" });
}
