/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Everything that touches the system for the NFS provider: exportfs,
 * /etc/exports and /etc/exports.d, nfs.conf through nfsconf, the kernel
 * NFS server state in /proc/fs/nfsd.
 */

import cockpit from "cockpit";

import { run, script, writeConfigFile, backupFile } from "../../lib/system.ts";
import { parseClientInfo, type NfsClient } from "./exports.ts";
import { parseExportfsDiagnostics, parseNfsConfDump, type NfsDiagnostic, type NfsConf } from "./parsers.ts";

export type { NfsDiagnostic, NfsConf };

const _ = cockpit.gettext;

export const EXPORTS_FILE = "/etc/exports";
export const NFS_CONF = "/etc/nfs.conf";

export interface NfsEnvironment {
    installed: boolean;
    tools: Record<string, boolean>;
    version: string;
    units: { server: string | null, rpcbind: string | null };
    /** /etc/exports.d exists */
    exportsDir: boolean;
    /** /etc/exports.d/*.exports, read after /etc/exports */
    extraFiles: string[];
    /** content of /proc/fs/nfsd/versions when the kernel server runs, e.g. "-2 +3 +4 +4.1 +4.2" */
    kernelVersions: string | null;
    /** package providing the server on this distribution */
    packageName: string;
}

const DETECT_SCRIPT = `
for t in exportfs nfsconf showmount unshare findmnt ip; do
    if command -v "$t" >/dev/null 2>&1; then echo "tool.$t=1"; fi
done
if command -v showmount >/dev/null 2>&1; then showmount --version 2>/dev/null | sed -n 's/.* for /version=/p'; fi
for u in nfs-server nfs-kernel-server rpcbind; do
    for d in /etc/systemd/system /run/systemd/system /usr/local/lib/systemd/system /usr/lib/systemd/system /lib/systemd/system; do
        if [ -e "$d/$u.service" ] && [ "$(readlink -f "$d/$u.service")" != /dev/null ]; then
            echo "unit.$u=$(basename "$(readlink -f "$d/$u.service")" .service)"; break
        fi
    done
done
if [ -d /etc/exports.d ]; then
    echo exportsdir=1
    for f in /etc/exports.d/*.exports; do
        [ -f "$f" ] || continue
        case "$(basename "$f")" in .*) ;; *) echo "extra=$f" ;; esac
    done
fi
if [ -r /proc/fs/nfsd/versions ]; then echo "versions=$(cat /proc/fs/nfsd/versions)"; fi
if [ -r /etc/os-release ]; then . /etc/os-release; echo "os=$ID $ID_LIKE"; fi
`;

export async function detectEnvironment(): Promise<NfsEnvironment> {
    const out = await script(DETECT_SCRIPT, [], { superuser: "try" });
    const kv: Record<string, string> = {};
    const extraFiles: string[] = [];
    for (const line of out.split("\n")) {
        const i = line.indexOf("=");
        if (i <= 0)
            continue;
        const k = line.slice(0, i);
        const v = line.slice(i + 1).trim();
        if (k === "extra")
            extraFiles.push(v);
        else
            kv[k] = v;
    }
    const tools: Record<string, boolean> = {};
    for (const k of Object.keys(kv))
        if (k.startsWith("tool."))
            tools[k.slice(5)] = true;
    const unit = (...names: string[]) => {
        const found = names.find(n => kv["unit." + n]);
        return found ? kv["unit." + found] : null;
    };
    const os = (kv.os ?? "").split(/\s+/);
    return {
        installed: !!tools.exportfs,
        tools,
        version: kv.version ?? "",
        units: { server: unit("nfs-server", "nfs-kernel-server"), rpcbind: unit("rpcbind") },
        exportsDir: kv.exportsdir === "1",
        extraFiles: extraFiles.sort(),
        kernelVersions: kv.versions ?? null,
        packageName: os.some(id => id === "debian" || id === "ubuntu") ? "nfs-kernel-server" : "nfs-utils",
    };
}

/* === exportfs ==================================================== */

export interface ExportsCheck {
    /** the candidate was checked by exportfs itself */
    checked: boolean;
    ok: boolean;
    diagnostics: NfsDiagnostic[];
}

const VALIDATE_SCRIPT = `
t=$(mktemp -d) || exit 1
trap 'rm -rf "$t"' EXIT
cat > "$t/candidate"
mkdir "$t/state"
unshare --mount sh -c 'mount --bind "$1/candidate" "$2" && mount --bind "$1/state" /var/lib/nfs && exportfs -ra' -- "$t" "$1" 2>"$t/err"
echo "rc=$?"
cat "$t/err"
`;

/**
 * Check a candidate exports file with exportfs, in a private mount namespace
 * where it replaces the real file: nothing on the system changes. Without
 * unshare, the check is skipped and only the result of applying is known.
 */
export async function checkExports(env: NfsEnvironment, file: string, text: string): Promise<ExportsCheck> {
    if (!env.tools.unshare)
        return { checked: false, ok: true, diagnostics: [] };
    let out: string;
    try {
        out = await script(VALIDATE_SCRIPT, [file], { superuser: "require", input: text });
    } catch {
        return { checked: false, ok: true, diagnostics: [] };
    }
    const m = out.match(/^rc=(\d+)\n([\s\S]*)$/);
    if (!m)
        return { checked: false, ok: true, diagnostics: [] };
    const diagnostics = parseExportfsDiagnostics(m[2]);
    // mount failures (no permission for namespaces) are not a verdict on the file
    if (/mount: /.test(m[2]) && !diagnostics.some(d => /exports/.test(d.message)))
        return { checked: false, ok: true, diagnostics: [] };
    return { checked: true, ok: !diagnostics.some(d => d.level === "error"), diagnostics };
}

const APPLY_SCRIPT = `
exportfs -ra 2>&1
echo "rc=$?"
`;

export async function applyExports(): Promise<NfsDiagnostic[]> {
    const out = await script(APPLY_SCRIPT, [], { superuser: "require" });
    return parseExportfsDiagnostics(out.replace(/rc=\d+\s*$/, ""));
}

export class ExportsRejected extends Error {
    diagnostics: NfsDiagnostic[];
    constructor(diagnostics: NfsDiagnostic[]) {
        super(_("exportfs rejects this configuration"));
        this.diagnostics = diagnostics;
    }
}

export interface ExportsSaveResult {
    tag: string;
    diagnostics: NfsDiagnostic[];
}

/** Validate, back up, write and apply an exports file. */
export async function saveExports(env: NfsEnvironment, file: string, text: string, tag: string | null): Promise<ExportsSaveResult> {
    const check = await checkExports(env, file, text);
    if (!check.ok)
        throw new ExportsRejected(check.diagnostics);
    const newTag = await writeConfigFile(file, text, tag);
    const diagnostics = await applyExports();
    return { tag: newTag, diagnostics: check.checked ? check.diagnostics : diagnostics };
}

export async function activeExports(): Promise<string> {
    try {
        return await run(["exportfs", "-v"], { superuser: "try" });
    } catch {
        return "";
    }
}

/* === nfs.conf ==================================================== */

export async function readNfsConf(): Promise<NfsConf> {
    try {
        return parseNfsConfDump(await run(["nfsconf", "--dump"], { superuser: "try" }));
    } catch {
        return new Map();
    }
}

/** Set or remove settings of /etc/nfs.conf, after a backup. */
export async function writeNfsConf(changes: { section: string, key: string, value: string | null }[]): Promise<void> {
    if (changes.length === 0)
        return;
    await backupFile(NFS_CONF);
    for (const c of changes) {
        if (!/^[\w.-]+$/.test(c.section) || !/^[\w.-]+$/.test(c.key))
            throw new Error("invalid setting name");
        if (c.value !== null && /[\r\n]/.test(c.value))
            throw new Error("invalid value");
        const args = c.value === null
            ? ["nfsconf", "--file", NFS_CONF, "--modified", "Cockpit", "--unset", c.section, c.key]
            : ["nfsconf", "--file", NFS_CONF, "--modified", "Cockpit", "--set", c.section, c.key, c.value];
        try {
            await run(args, { superuser: "require" });
        } catch (ex) {
            // --unset fails when the setting is not in the file: nothing to remove
            if (c.value !== null)
                throw ex;
        }
    }
}

/* === clients ===================================================== */

const CLIENTS_SCRIPT = `
[ -d /proc/fs/nfsd/clients ] || { echo "none"; exit 0; }
for d in /proc/fs/nfsd/clients/*/; do
    [ -r "$d/info" ] || continue
    echo "== $(basename "$d")"
    cat "$d/info"
done
`;

/** NFSv4 clients known to the kernel server, null when the list is not available. */
export async function listClients(): Promise<NfsClient[] | null> {
    const out = await script(CLIENTS_SCRIPT, [], { superuser: "require" });
    if (out.trim() === "none")
        return null;
    const clients: NfsClient[] = [];
    for (const chunk of out.split(/^== /m).slice(1)) {
        const nl = chunk.indexOf("\n");
        clients.push(parseClientInfo(chunk.slice(0, nl).trim(), chunk.slice(nl + 1)));
    }
    return clients;
}

/** Ask the kernel to forget a client (its state is released, it can come back). */
export async function expireClient(id: string): Promise<void> {
    if (!/^\d+$/.test(id))
        throw new Error("invalid client id");
    await script('echo expire > "/proc/fs/nfsd/clients/$1/ctl"', [id], { superuser: "require" });
}

/* === paths ======================================================= */

export interface MountInfo {
    source: string;
    fstype: string;
    target: string;
}

export async function mountOf(path: string): Promise<MountInfo | null> {
    try {
        const out = (await run(["findmnt", "-n", "-o", "SOURCE,FSTYPE,TARGET", "-T", path], { superuser: "try" })).trim();
        const [source, fstype, ...target] = out.split(/\s+/);
        return source ? { source, fstype, target: target.join(" ") } : null;
    } catch {
        return null;
    }
}

export async function pathExists(path: string): Promise<boolean | null> {
    try {
        const out = await run(["sh", "-c", 'if [ -d "$1" ]; then echo dir; elif [ -e "$1" ]; then echo other; else echo none; fi', "--", path], { superuser: "try" });
        return out.trim() === "dir";
    } catch {
        return null;
    }
}

/** IPv4 networks of this machine, to suggest them as clients. */
export async function localNetworks(env: NfsEnvironment): Promise<string[]> {
    if (!env.tools.ip)
        return [];
    try {
        const out = await run(["ip", "-o", "-4", "addr", "show", "scope", "global"]);
        const result = new Set<string>();
        for (const m of out.matchAll(/inet (\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)/g)) {
            const prefix = Number(m[5]);
            const addr = ((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0;
            const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
            const net = (addr & mask) >>> 0;
            result.add(`${net >>> 24}.${(net >>> 16) & 255}.${(net >>> 8) & 255}.${net & 255}/${prefix}`);
        }
        return Array.from(result);
    } catch {
        return [];
    }
}
