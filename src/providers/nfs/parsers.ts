/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Parsers for the output of the NFS tools. No Cockpit dependency, unit
 * tested in test/unit/exports.test.ts.
 */

export interface NfsDiagnostic {
    level: "error" | "warning" | "info";
    message: string;
}

/** Classify what exportfs prints on stderr; continuation lines are joined. */
export function parseExportfsDiagnostics(stderr: string): NfsDiagnostic[] {
    const messages: string[] = [];
    for (const line of stderr.split("\n")) {
        if (line.trim() === "")
            continue;
        if (/^\s/.test(line) && messages.length)
            messages[messages.length - 1] += " " + line.trim();
        else
            messages.push(line.trim().replace(/^exportfs:\s*/, ""));
    }
    const result: NfsDiagnostic[] = [];
    for (const message of messages) {
        let level: NfsDiagnostic["level"] = "error";
        if (/Failed to resolve|Failed to stat|does not support NFS export|duplicated export entries/i.test(message))
            level = "warning";
        else if (/Neither 'subtree_check' or 'no_subtree_check' specified/.test(message))
            level = "info";
        if (!result.some(d => d.message === message))
            result.push({ level, message });
    }
    return result;
}

export type NfsConf = Map<string, Map<string, string>>;

/** Parse `nfsconf --dump`: "[section]" lines and " key = value" lines. */
export function parseNfsConfDump(text: string): NfsConf {
    const conf: NfsConf = new Map();
    let section: Map<string, string> | null = null;
    for (const line of text.split("\n")) {
        const s = line.match(/^\s*\[\s*([^\]]+?)\s*\]\s*$/);
        if (s) {
            const name = s[1].toLowerCase();
            section = conf.get(name) ?? new Map();
            conf.set(name, section);
            continue;
        }
        const kv = line.match(/^\s*([^=#;\s][^=]*?)\s*=\s*(.*?)\s*$/);
        if (kv && section)
            section.set(kv[1].toLowerCase(), kv[2].replace(/^"(.*)"$/, "$1"));
    }
    return conf;
}
