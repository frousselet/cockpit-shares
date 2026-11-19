/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Parsers for the output of the Samba command line tools.
 * No Cockpit dependency, unit tested in test/unit/parsers.test.ts.
 */

/* === testparm ================================================= */

export type DiagnosticLevel = "error" | "warning" | "info";

export interface Diagnostic {
    level: DiagnosticLevel;
    message: string;
}

const NOISE = [
    /^Load smb config files from /,
    /^Loaded services file OK\.?$/,
    /^Weak crypto is allowed/,
    /^Server role: /,
    /^Press enter to see a dump of your service definitions/,
    /^# Global parameters$/,
];

/** Classify the messages testparm prints on stderr. */
export function parseTestparmDiagnostics(stderr: string, exitCode: number): Diagnostic[] {
    const result: Diagnostic[] = [];
    for (const raw of stderr.split("\n")) {
        const line = raw.trim();
        if (line === "" || NOISE.some(rx => rx.test(line)))
            continue;
        let level: DiagnosticLevel;
        if (/^Error loading services/.test(line) || /^ERROR\b/i.test(line) ||
            /value is not boolean/.test(line) || /^Invalid /.test(line) || /^Can't load /.test(line))
            level = "error";
        else if (/^NOTE:/.test(line))
            level = "info";
        else if (/^WARNING:/i.test(line) || /^Unknown parameter/.test(line) || /^Ignoring unknown parameter/.test(line))
            level = "warning";
        else
            level = exitCode === 0 ? "warning" : "error";
        // "Unknown parameter encountered" and "Ignoring unknown parameter" say the same thing
        if (/^Ignoring unknown parameter/.test(line) &&
            result.some(d => d.message.startsWith("Unknown parameter encountered") &&
                        d.message.includes(line.replace(/^Ignoring unknown parameter\s*/, ""))))
            continue;
        result.push({ level, message: line.replace(/^(WARNING|NOTE|ERROR):\s*/i, "") });
    }
    if (exitCode !== 0 && !result.some(d => d.level === "error"))
        result.push({ level: "error", message: "testparm failed" });
    return result;
}

/* === pdbedit -L -v ============================================ */

export interface SambaUser {
    name: string;
    uid?: number;
    fullName: string;
    sid: string;
    flags: string;
    disabled: boolean;
    passwordNotRequired: boolean;
    passwordNeverExpires: boolean;
    locked: boolean;
    /** seconds since epoch, null when never or unknown */
    passwordLastSet: number | null;
    logonTime: number | null;
    badPasswordCount: number;
}

function parseTime(value: string | undefined): number | null {
    if (!value || value === "0" || /^never$/i.test(value))
        return null;
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

/**
 * Parse `pdbedit -L -v`. Records are separated by lines of dashes, each line
 * is "Label: value" (some labels have a blank before the colon).
 */
export function parsePdbeditVerbose(output: string): SambaUser[] {
    const users: SambaUser[] = [];
    for (const chunk of output.split(/^-{5,}\s*$/m)) {
        const fields: Record<string, string> = {};
        for (const line of chunk.split("\n")) {
            const m = line.match(/^([^:]+?)\s*:\s?(.*)$/);
            if (m)
                fields[m[1].trim().toLowerCase()] = m[2].trim();
        }
        const name = fields["unix username"];
        if (!name)
            continue;
        const flags = (fields["account flags"] ?? "").replace(/[[\]\s]/g, "");
        users.push({
            name,
            fullName: fields["full name"] ?? "",
            sid: fields["user sid"] ?? "",
            flags,
            disabled: flags.includes("D"),
            passwordNotRequired: flags.includes("N"),
            passwordNeverExpires: flags.includes("X"),
            locked: flags.includes("L"),
            passwordLastSet: parseTime(fields["password last set"]),
            logonTime: parseTime(fields["logon time"]),
            badPasswordCount: parseInt(fields["bad password count"] ?? "0", 10) || 0,
        });
    }
    return users;
}

/** Parse `pdbedit -L` ("name:uid:full name" per line). */
export function parsePdbeditList(output: string): { name: string, uid: number, fullName: string }[] {
    return output.split("\n").filter(l => l.includes(":"))
            .map(line => {
                const [name, uid, ...rest] = line.split(":");
                return { name, uid: parseInt(uid, 10), fullName: rest.join(":") };
            });
}

/* === smbstatus --json ========================================= */

interface ServerId {
    pid: string;
}

interface CryptoInfo {
    cipher: string;
    degree: string;
}

export interface SmbSession {
    id: string;
    pid: string;
    username: string;
    groupname: string;
    uid: number;
    gid: number;
    remoteMachine: string;
    hostname: string;
    dialect: string;
    encryption: CryptoInfo | null;
    signing: CryptoInfo | null;
}

export interface SmbTreeConnect {
    id: string;
    service: string;
    pid: string;
    sessionId: string;
    machine: string;
    connectedAt: string;
    encryption: CryptoInfo | null;
}

export interface SmbOpenFile {
    path: string;
    servicePath: string;
    filename: string;
    pid: string;
    uid: number;
    sharemode: string;
    access: string;
    oplock: string;
    lease: string;
    openedAt: string;
}

export interface SmbStatus {
    version: string;
    sessions: SmbSession[];
    tcons: SmbTreeConnect[];
    openFiles: SmbOpenFile[];
}

type JsonMap = Record<string, unknown>;

function asMap(v: unknown): JsonMap {
    return v && typeof v === "object" ? v as JsonMap : {};
}

function str(v: unknown): string {
    return v === undefined || v === null ? "" : String(v);
}

function crypto(v: unknown): CryptoInfo | null {
    const m = asMap(v);
    if (!("cipher" in m))
        return null;
    return { cipher: str(m.cipher), degree: str(m.degree) };
}

function flagText(v: unknown): string {
    const m = asMap(v);
    if ("text" in m)
        return str(m.text);
    // oplock/lease objects list their active flags as booleans
    return Object.entries(m).filter(([, b]) => b === true)
            .map(([k]) => k)
            .join(", ");
}

export function parseSmbstatusJson(text: string): SmbStatus {
    const data = asMap(JSON.parse(text));
    const sessions = Object.entries(asMap(data.sessions)).map(([id, v]) => {
        const s = asMap(v);
        return {
            id,
            pid: str((s.server_id as ServerId | undefined)?.pid),
            username: str(s.username),
            groupname: str(s.groupname),
            uid: Number(s.uid ?? -1),
            gid: Number(s.gid ?? -1),
            remoteMachine: str(s.remote_machine),
            hostname: str(s.hostname),
            dialect: str(s.session_dialect),
            encryption: crypto(s.encryption),
            signing: crypto(s.signing),
        };
    });
    const tcons = Object.entries(asMap(data.tcons)).map(([id, v]) => {
        const t = asMap(v);
        return {
            id,
            service: str(t.service),
            pid: str((t.server_id as ServerId | undefined)?.pid),
            sessionId: str(t.session_id),
            machine: str(t.machine),
            connectedAt: str(t.connected_at),
            encryption: crypto(t.encryption),
        };
    });
    const openFiles: SmbOpenFile[] = [];
    for (const [path, v] of Object.entries(asMap(data.open_files))) {
        const f = asMap(v);
        for (const o of Object.values(asMap(f.opens))) {
            const open = asMap(o);
            openFiles.push({
                path,
                servicePath: str(f.service_path),
                filename: str(f.filename),
                pid: str((open.server_id as ServerId | undefined)?.pid),
                uid: Number(open.uid ?? -1),
                sharemode: flagText(open.sharemode),
                access: flagText(open.access_mask),
                oplock: flagText(open.oplock),
                lease: flagText(open.lease),
                openedAt: str(open.opened_at),
            });
        }
    }
    return { version: str(data.version), sessions, tcons, openFiles };
}

/**
 * Fallback for Samba < 4.16 which has no --json: parse `smbstatus -p` and `smbstatus -S`.
 * Both print a header, a line of dashes and then whitespace separated columns.
 */
export function parseSmbstatusText(processes: string, shares: string): SmbStatus {
    const rows = (text: string) => {
        const lines = text.split("\n");
        const dash = lines.findIndex(l => /^-{5,}/.test(l.trim()));
        return dash < 0 ? [] : lines.slice(dash + 1).filter(l => l.trim() !== "");
    };
    const sessions: SmbSession[] = rows(processes).map((line, i) => {
        // PID Username Group Machine Protocol Version Encryption Signing
        const parts = line.trim().split(/\s+/);
        const [pid, username, groupname] = parts;
        const machine = parts.slice(3).join(" ");
        const m = machine.match(/^(.*?\))\s+(\S+)\s*(\S*)\s*(\S*)/) ?? machine.match(/^(\S+)\s+(\S+)\s*(\S*)\s*(\S*)/);
        const where = m ? m[1] : machine;
        const crypt = (v: string | undefined) => (v && v !== "-" ? { cipher: v, degree: "" } : null);
        return {
            id: String(i),
            pid,
            username: username ?? "",
            groupname: groupname ?? "",
            uid: -1,
            gid: -1,
            remoteMachine: where.replace(/\s*\(.*\)$/, ""),
            hostname: where.match(/\((.*)\)$/)?.[1] ?? where,
            dialect: m ? m[2] : "",
            encryption: crypt(m?.[3]),
            signing: crypt(m?.[4]),
        };
    });
    const tcons: SmbTreeConnect[] = rows(shares).map((line, i) => {
        // Service pid Machine Connected at Encryption Signing
        const parts = line.trim().split(/\s+/);
        return {
            id: String(i),
            service: parts[0],
            pid: parts[1],
            sessionId: "",
            machine: parts[2] ?? "",
            connectedAt: parts.slice(3, -2).join(" "),
            encryption: null,
        };
    });
    return { version: "", sessions, tcons, openFiles: [] };
}

/* === misc ===================================================== */

/** Parse `smbd -b` and keep the build paths (CONFIGFILE, LOCKDIR, ...). */
export function parseBuildOptions(output: string): Record<string, string> {
    const result: Record<string, string> = {};
    let inPaths = false;
    for (const line of output.split("\n")) {
        if (/^Paths:/.test(line)) {
            inPaths = true;
            continue;
        }
        if (inPaths) {
            const m = line.match(/^\s+(\w+):\s*(.*)$/);
            if (m)
                result[m[1]] = m[2].trim();
            else if (line.trim() !== "")
                inPaths = false;
        }
    }
    return result;
}

/** "Version 4.19.5-Ubuntu" -> [4, 19, 5] */
export function parseSambaVersion(output: string): number[] | null {
    const m = output.match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionAtLeast(version: number[] | null, ...wanted: number[]): boolean {
    if (!version)
        return false;
    for (let i = 0; i < wanted.length; i++) {
        if ((version[i] ?? 0) > wanted[i])
            return true;
        if ((version[i] ?? 0) < wanted[i])
            return false;
    }
    return true;
}

export interface PasswdEntry {
    name: string;
    uid: number;
    gid: number;
    gecos: string;
    home: string;
    shell: string;
}

export function parsePasswd(text: string): PasswdEntry[] {
    return text.split("\n").filter(l => l && !l.startsWith("#"))
            .map(line => {
                const [name, , uid, gid, gecos, home, shell] = line.split(":");
                return { name, uid: Number(uid), gid: Number(gid), gecos: (gecos ?? "").split(",")[0], home: home ?? "", shell: shell ?? "" };
            })
            .filter(e => e.name);
}

export interface GroupEntry {
    name: string;
    gid: number;
    members: string[];
}

export function parseGroup(text: string): GroupEntry[] {
    return text.split("\n").filter(l => l && !l.startsWith("#"))
            .map(line => {
                const [name, , gid, members] = line.split(":");
                return { name, gid: Number(gid), members: (members ?? "").split(",").filter(Boolean) };
            })
            .filter(e => e.name);
}

/** `stat -c '%F|%U|%G|%a|%C'` -> path information; %C is "?" without SELinux */
export interface PathInfo {
    exists: boolean;
    isDirectory: boolean;
    owner: string;
    group: string;
    mode: string;
    selinuxContext: string | null;
}

export function parseStat(output: string): PathInfo {
    const line = output.trim();
    if (!line)
        return { exists: false, isDirectory: false, owner: "", group: "", mode: "", selinuxContext: null };
    const [type, owner, group, mode, context] = line.split("|");
    return {
        exists: true,
        isDirectory: type === "directory",
        owner,
        group,
        mode,
        selinuxContext: context && context !== "?" ? context : null,
    };
}

/** "system_u:object_r:samba_share_t:s0" -> "samba_share_t" */
export function selinuxType(context: string | null): string | null {
    if (!context)
        return null;
    const parts = context.split(":");
    return parts.length >= 3 ? parts[2] : null;
}

/** SELinux types smbd may serve; see samba_selinux(8). */
export const SELINUX_SHAREABLE_TYPES = ["samba_share_t", "public_content_t", "public_content_rw_t"];
