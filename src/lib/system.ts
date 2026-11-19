/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * System helpers shared by the share providers: commands through the Cockpit
 * bridge, configuration file writes with backups, history of the backups.
 */

import cockpit from "cockpit";

const _ = cockpit.gettext;

/* daemons and their tools live in sbin, which is not always in the bridge's PATH */
export const ENV = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"];

export const BACKUP_DIR = "/var/lib/cockpit-shares/backups";
const BACKUP_KEEP = 20;

export class CommandError extends Error {
    detail: string;
    constructor(message: string, detail = "") {
        super(message);
        this.detail = detail;
    }
}

export class ConflictError extends Error {}

export function errorText(ex: unknown): string {
    if (ex instanceof Error)
        return ex.message;
    if (ex && typeof ex === "object" && "message" in ex)
        return String((ex as { message: unknown }).message);
    return String(ex);
}

export interface RunOptions {
    superuser?: "try" | "require";
    input?: string;
}

export async function run(args: string[], options: RunOptions = {}): Promise<string> {
    try {
        const proc = cockpit.spawn(args, { superuser: options.superuser ?? "try", err: "message", environ: ENV });
        if (options.input !== undefined)
            proc.input(options.input);
        return await proc;
    } catch (ex) {
        throw new CommandError(cockpit.format(_("Command $0 failed"), args[0]), errorText(ex));
    }
}

export async function script(code: string, args: string[], options: RunOptions = {}): Promise<string> {
    try {
        const proc = cockpit.script(code, args, { superuser: options.superuser ?? "try", err: "message", environ: ENV });
        if (options.input !== undefined)
            proc.input(options.input);
        return await proc;
    } catch (ex) {
        throw new CommandError(_("Command failed"), errorText(ex));
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
ls -1t "$dir/$base".[0-9]*-[0-9]* 2>/dev/null | tail -n +$((keep + 1)) | while read -r old; do rm -f -- "$old"; done
`;

/** Keep a copy of a configuration file before changing it. */
export async function backupFile(path: string): Promise<void> {
    await script(BACKUP_SCRIPT, [path, BACKUP_DIR, String(BACKUP_KEEP)], { superuser: "require" });
}

export interface Backup {
    /** file the copy was made of */
    source: string;
    /** the copy */
    file: string;
    date: Date;
}

export async function listBackups(sources: string[]): Promise<Backup[]> {
    let out = "";
    try {
        out = await run(["sh", "-c", 'cd "$1" 2>/dev/null && ls -1 || true', "--", BACKUP_DIR], { superuser: "require" });
    } catch {
        return [];
    }
    const result: Backup[] = [];
    for (const name of out.split("\n")) {
        for (const source of sources) {
            const base = source.split("/").pop()!;
            const m = name.match(/^(.*)\.(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
            if (m && m[1] === base) {
                result.push({
                    source,
                    file: `${BACKUP_DIR}/${name}`,
                    date: new Date(+m[2], +m[3] - 1, +m[4], +m[5], +m[6], +m[7]),
                });
            }
        }
    }
    return result.sort((a, b) => b.date.getTime() - a.date.getTime());
}

export async function readFile(path: string, superuser: "try" | "require" = "require"): Promise<string> {
    const handle = cockpit.file(path, { superuser });
    try {
        return (await handle.read()) ?? "";
    } finally {
        handle.close();
    }
}

/**
 * Back up and replace a configuration file atomically. `tag` is the tag of
 * the version the change was based on ("-" for a new file); the write fails
 * with ConflictError when the file changed in the meantime.
 */
export async function writeConfigFile(path: string, text: string, tag: string | null): Promise<string> {
    await backupFile(path);
    const handle = cockpit.file(path, { superuser: "require" });
    try {
        return await handle.replace(text, tag ?? undefined);
    } catch (ex) {
        const problem = (ex as { problem?: string }).problem;
        if (problem === "change-conflict")
            throw new ConflictError(_("The configuration file was changed by someone else. Reload it and try again."));
        throw new CommandError(_("Writing the configuration failed"), errorText(ex));
    } finally {
        handle.close();
    }
}

export async function createDirectory(path: string, owner: string, group: string, mode: string): Promise<void> {
    if (!/^[0-7]{3,4}$/.test(mode))
        throw new Error("invalid mode");
    await run(["mkdir", "-p", "--", path], { superuser: "require" });
    await run(["chown", `${owner}:${group}`, "--", path], { superuser: "require" });
    await run(["chmod", mode, "--", path], { superuser: "require" });
}
