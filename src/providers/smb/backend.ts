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

const _ = cockpit.gettext;

/* Samba tools live in sbin on most distributions, which is not always in the bridge's PATH */
const ENV = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"];

export const BACKUP_DIR = "/var/lib/cockpit-shares/backups";
const BACKUP_KEEP = 20;

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

export class CommandError extends Error {
    detail: string;
    constructor(message: string, detail = "") {
        super(message);
        this.detail = detail;
    }
}

function errorText(ex: unknown): string {
    if (ex instanceof Error)
        return ex.message;
    if (ex && typeof ex === "object" && "message" in ex)
        return String((ex as { message: unknown }).message);
    return String(ex);
}

export async function run(args: string[], options: { superuser?: "try" | "require", input?: string } = {}): Promise<string> {
    try {
        const proc = cockpit.spawn(args, { superuser: options.superuser ?? "try", err: "message", environ: ENV });
        if (options.input !== undefined)
            proc.input(options.input);
        return await proc;
    } catch (ex) {
        throw new CommandError(cockpit.format(_("Command $0 failed"), args[0]), errorText(ex));
    }
}

async function script(code: string, args: string[], options: { superuser?: "try" | "require", input?: string } = {}): Promise<string> {
    try {
        const proc = cockpit.script(code, args, { superuser: options.superuser ?? "try", err: "message", environ: ENV });
        if (options.input !== undefined)
            proc.input(options.input);
        return await proc;
    } catch (ex) {
        throw new CommandError(_("Command failed"), errorText(ex));
    }
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

export class ConflictError extends Error {}

export class ValidationFailed extends Error {
    diagnostics: Diagnostic[];
    constructor(diagnostics: Diagnostic[]) {
        super(_("The configuration is not valid"));
        this.diagnostics = diagnostics;
    }
}

const BACKUP_SCRIPT = `
set -e
file="$1"; dir="$2"; keep="$3"
[ -f "$file" ] || exit 0
mkdir -p "$dir"
chmod 0700 "$dir"
base=$(basename "$file")
cp -p "$file" "$dir/$base.$(date +%Y%m%d-%H%M%S)"
ls -1t "$dir/$base."* 2>/dev/null | tail -n +$((keep + 1)) | while read -r old; do rm -f -- "$old"; done
`;

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

    await script(BACKUP_SCRIPT, [env.configFile, BACKUP_DIR, String(BACKUP_KEEP)], { superuser: "require" });

    let newTag: string;
    const handle = cockpit.file(env.configFile, { superuser: "require" });
    try {
        newTag = await handle.replace(text, tag ?? undefined);
    } catch (ex) {
        const problem = (ex as { problem?: string }).problem;
        if (problem === "change-conflict")
            throw new ConflictError(_("The configuration file was changed by someone else. Reload it and try again."));
        throw new CommandError(_("Writing the configuration failed"), errorText(ex));
    } finally {
        handle.close();
    }

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

export interface Backup {
    file: string;
    date: Date;
}

export async function listBackups(env: SmbEnvironment): Promise<Backup[]> {
    const base = env.configFile.split("/").pop()!;
    let out = "";
    try {
        out = await run(["sh", "-c", 'cd "$1" 2>/dev/null && ls -1 -- "$2".* 2>/dev/null || true', "--", BACKUP_DIR, base], { superuser: "require" });
    } catch {
        return [];
    }
    return out.split("\n").filter(Boolean)
            .map(name => {
                const m = name.match(/\.(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
                const date = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : new Date(0);
                return { file: `${BACKUP_DIR}/${name}`, date };
            })
            .sort((a, b) => b.date.getTime() - a.date.getTime());
}

export async function readFile(path: string): Promise<string> {
    const handle = cockpit.file(path, { superuser: "require" });
    try {
        return (await handle.read()) ?? "";
    } finally {
        handle.close();
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

export async function createDirectory(path: string, owner: string, group: string, mode: string): Promise<void> {
    if (!/^[0-7]{3,4}$/.test(mode))
        throw new Error("invalid mode");
    await run(["mkdir", "-p", "--", path], { superuser: "require" });
    await run(["chown", `${owner}:${group}`, "--", path], { superuser: "require" });
    await run(["chmod", mode, "--", path], { superuser: "require" });
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
