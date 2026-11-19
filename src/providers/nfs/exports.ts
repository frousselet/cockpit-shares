/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Lossless reader and editor for /etc/exports and /etc/exports.d/*.exports.
 *
 * Format (exports(5), nfs-utils):
 *  - '#' starts a comment that runs to the end of the line
 *  - a line ending in '\' continues on the next one
 *  - an entry is an export path followed by whitespace separated items:
 *      host(options)   options for one client, no blank before '('
 *      host            client with the default options
 *      -options        default options for the following clients of the line
 *  - a path containing blanks is quoted with double quotes, or written with
 *    "\ooo" octal escapes
 *
 * "host (rw)" is a classic mistake: "(rw)" is then a separate item that
 * applies to every host. Such items are reported as problems.
 *
 * Untouched lines are written back byte for byte. No Cockpit dependency.
 */

export interface ClientItem {
    kind: "client";
    /** host, network, wildcard, @netgroup, "*"; "" when written "(options)" alone */
    host: string;
    options: string[];
}

export interface DefaultsItem {
    kind: "defaults";
    options: string[];
}

export type ExportItem = ClientItem | DefaultsItem;

export interface ExportEntry {
    path: string;
    items: ExportItem[];
    /** trailing comment, with its '#' */
    comment: string;
}

export interface ExportsLine {
    kind: "blank" | "comment" | "entry";
    raw: string;
    entry?: ExportEntry;
    /** human readable problems found while parsing */
    problems?: string[];
}

/* === tokenizer ================================================== */

function splitLogical(text: string): string[][] {
    const physical = text.split(/\r?\n/);
    if (physical.length && physical[physical.length - 1] === "")
        physical.pop();
    const result: string[][] = [];
    let i = 0;
    while (i < physical.length) {
        const group = [physical[i]];
        while (/\\$/.test(stripComment(physical[i]).replace(/\s+$/, "")) && !/^\s*#/.test(physical[i]) && i + 1 < physical.length) {
            i++;
            group.push(physical[i]);
        }
        result.push(group);
        i++;
    }
    return result;
}

/** Remove a trailing comment, keeping '#' inside double quotes. */
function stripComment(line: string): string {
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '"')
            quoted = !quoted;
        else if (line[i] === "#" && !quoted)
            return line.slice(0, i);
    }
    return line;
}

function commentOf(line: string): string {
    const body = stripComment(line);
    return line.slice(body.length).replace(/\s+$/, "");
}

export function decodePath(raw: string): string {
    const unquoted = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    return unquoted.replace(/\\([0-7]{3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)));
}

export function encodePath(path: string): string {
    // characters exportfs would misread are written as octal escapes
    // eslint-disable-next-line no-control-regex
    const escaped = path.replace(/[\\"#]|[\x00-\x1f]/g, c => "\\" + c.charCodeAt(0).toString(8)
            .padStart(3, "0"));
    return /\s/.test(escaped) ? `"${escaped}"` : escaped;
}

function splitOptions(s: string): string[] {
    return s.split(",").map(o => o.trim())
            .filter(o => o !== "");
}

export function parseEntry(logical: string): { entry: ExportEntry | null, problems: string[] } {
    const problems: string[] = [];
    const comment = commentOf(logical);
    let body = stripComment(logical).trim();
    if (body === "")
        return { entry: null, problems };

    let rawPath: string;
    if (body.startsWith('"')) {
        const end = body.indexOf('"', 1);
        if (end < 0) {
            problems.push("unterminated quote in the export path");
            rawPath = body;
            body = "";
        } else {
            rawPath = body.slice(0, end + 1);
            body = body.slice(end + 1);
        }
    } else {
        const m = body.match(/^\S+/)!;
        rawPath = m[0];
        body = body.slice(rawPath.length);
    }

    const items: ExportItem[] = [];
    // an item is "-opts", "host", "host(opts)" or "(opts)"; options never contain blanks
    const rx = /\s*([^\s(]*)(?:\(([^)]*)\))?/y;
    let pos = 0;
    while (pos < body.length) {
        rx.lastIndex = pos;
        const m = rx.exec(body);
        if (!m || m[0] === "") {
            if (/^\s*$/.test(body.slice(pos)))
                break;
            problems.push(`cannot read "${body.slice(pos).trim()}"`);
            break;
        }
        pos = rx.lastIndex;
        const [, word, opts] = m;
        if (word === "" && opts === undefined)
            continue;
        if (word.startsWith("-") && opts === undefined) {
            items.push({ kind: "defaults", options: splitOptions(word.slice(1)) });
        } else {
            if (word === "" && opts !== undefined)
                problems.push(`"(${opts})" is separated from its host by a blank: these options apply to every host`);
            items.push({ kind: "client", host: word, options: opts === undefined ? [] : splitOptions(opts) });
        }
    }
    if (!items.some(i => i.kind === "client"))
        problems.push("no client: the path is exported to every host with the default options");
    return { entry: { path: decodePath(rawPath), items, comment }, problems };
}

export function serializeEntry(entry: ExportEntry): string {
    const parts = [encodePath(entry.path)];
    for (const item of entry.items) {
        if (item.kind === "defaults")
            parts.push("-" + item.options.join(","));
        else
            parts.push((item.host === "" ? "*" : item.host) + (item.options.length ? "(" + item.options.join(",") + ")" : ""));
    }
    let line = parts.join(" ");
    if (entry.comment)
        line += " " + entry.comment;
    return line;
}

/* === file ======================================================= */

export class ExportsFile {
    lines: ExportsLine[];
    trailingNewline: boolean;

    constructor(lines: ExportsLine[], trailingNewline = true) {
        this.lines = lines;
        this.trailingNewline = trailingNewline;
    }

    static parse(text: string): ExportsFile {
        const lines: ExportsLine[] = [];
        for (const group of splitLogical(text)) {
            const raw = group.join("\n");
            const logical = group.map((l, i) => (i < group.length - 1 ? stripComment(l).replace(/\\\s*$/, " ") : l)).join("");
            if (logical.trim() === "") {
                lines.push({ kind: "blank", raw });
            } else if (/^\s*#/.test(logical)) {
                lines.push({ kind: "comment", raw });
            } else {
                const { entry, problems } = parseEntry(logical);
                lines.push(entry ? { kind: "entry", raw, entry, problems } : { kind: "comment", raw });
            }
        }
        return new ExportsFile(lines, text === "" || text.endsWith("\n"));
    }

    toString(): string {
        if (this.lines.length === 0)
            return "";
        return this.lines.map(l => l.raw).join("\n") + (this.trailingNewline ? "\n" : "");
    }

    clone(): ExportsFile {
        return ExportsFile.parse(this.toString());
    }

    entries(): { index: number, entry: ExportEntry, problems: string[] }[] {
        return this.lines.flatMap((l, index) => (l.kind === "entry" ? [{ index, entry: l.entry!, problems: l.problems ?? [] }] : []));
    }

    /** Line index of the n-th entry exporting a path (0 based), -1 when absent. */
    find(path: string, occurrence = 0): number {
        let n = 0;
        for (let i = 0; i < this.lines.length; i++) {
            if (this.lines[i].kind === "entry" && this.lines[i].entry!.path === path) {
                if (n === occurrence)
                    return i;
                n++;
            }
        }
        return -1;
    }

    replace(index: number, entry: ExportEntry): void {
        const line = this.lines[index];
        if (!line || line.kind !== "entry")
            throw new Error("not an export entry");
        // keep the indentation of the original line
        const indent = line.raw.match(/^[ \t]*/)![0];
        this.lines[index] = { kind: "entry", raw: indent + serializeEntry(entry), entry, problems: [] };
    }

    add(entry: ExportEntry): void {
        this.lines.push({ kind: "entry", raw: serializeEntry(entry), entry, problems: [] });
    }

    remove(index: number): void {
        if (this.lines[index]?.kind !== "entry")
            throw new Error("not an export entry");
        this.lines.splice(index, 1);
    }
}

/* === options ==================================================== */

/** Options that apply to a client: defaults before it on the line, then its own. */
export function effectiveOptions(entry: ExportEntry, clientIndex: number): string[] {
    const result: string[] = [];
    entry.items.forEach((item, i) => {
        if (item.kind === "defaults" && i < clientIndex)
            result.push(...item.options);
        if (i === clientIndex && item.kind === "client")
            result.push(...item.options);
    });
    return result;
}

/** Mutually exclusive flags of exports(5); synonyms share a group. */
export const FLAG_GROUPS: string[][] = [
    ["ro", "rw"],
    ["sync", "async"],
    ["secure", "insecure"],
    ["wdelay", "no_wdelay"],
    ["hide", "nohide"],
    ["crossmnt", "nocrossmnt"],
    ["subtree_check", "no_subtree_check"],
    ["secure_locks", "auth_nlm", "insecure_locks", "no_auth_nlm"],
    ["root_squash", "no_root_squash"],
    ["all_squash", "no_all_squash"],
    ["pnfs", "no_pnfs"],
    ["acl", "no_acl"],
];

/**
 * Options as exportfs applies them: a later flag of the same group, or a
 * later value of the same option, replaces an earlier one. "sec=" changes the
 * meaning of the options that follow it and is kept as is.
 */
export function resolveOptions(options: string[]): string[] {
    const keyOf = (o: string) => {
        const name = optionName(o);
        const group = FLAG_GROUPS.findIndex(g => g.includes(name));
        return group >= 0 ? "flag:" + group : (optionValue(o) !== null ? "value:" + name : "word:" + name);
    };
    if (options.filter(o => optionName(o) === "sec").length > 1)
        return [...options];
    const result: string[] = [];
    options.forEach((o, i) => {
        const k = keyOf(o);
        if (!options.slice(i + 1).some(later => keyOf(later) === k))
            result.push(o);
    });
    return result;
}

export function optionName(option: string): string {
    const i = option.indexOf("=");
    return i < 0 ? option : option.slice(0, i);
}

export function optionValue(option: string): string | null {
    const i = option.indexOf("=");
    return i < 0 ? null : option.slice(i + 1);
}

/* === exportfs -v ================================================= */

export interface ActiveExport {
    path: string;
    client: string;
    options: string[];
}

/**
 * Parse `exportfs -v`. The client follows the path on the same line, or on
 * the next line (indented) when the path is long; "<world>" means every host.
 */
export function parseExportfsVerbose(output: string): ActiveExport[] {
    const result: ActiveExport[] = [];
    let path: string | null = null;
    for (const line of output.split("\n")) {
        if (line.trim() === "")
            continue;
        let rest = line;
        if (!/^\s/.test(line)) {
            // paths are printed as is, blanks included; the client ends the line
            const m = line.match(/^(.*?)\s+(\S+\([^)]*\))$/);
            path = decodePath((m ? m[1] : line).trim());
            rest = m ? m[2] : "";
        }
        const c = rest.trim().match(/^(\S+?)\(([^)]*)\)$/);
        if (c && path !== null)
            result.push({ path, client: c[1] === "<world>" ? "*" : c[1], options: splitOptions(c[2]) });
    }
    return result;
}

/* === /proc/fs/nfsd/clients/<id>/info ============================ */

export interface NfsClient {
    id: string;
    address: string;
    name: string;
    minorVersion: number | null;
    status: string;
    implementation: string;
}

export function parseClientInfo(id: string, text: string): NfsClient {
    const fields: Record<string, string> = {};
    for (const line of text.split("\n")) {
        const m = line.match(/^([^:]+):\s*(.*)$/);
        if (m)
            fields[m[1].trim().toLowerCase()] = m[2].trim().replace(/^"(.*)"$/, "$1");
    }
    return {
        id,
        address: fields.address ?? "",
        name: fields.name ?? "",
        minorVersion: fields["minor version"] !== undefined ? Number(fields["minor version"]) : null,
        status: fields.status ?? "",
        implementation: [fields["implementation domain"], fields["implementation name"]].filter(Boolean).join(" "),
    };
}

/** Check a client specification as exportfs reads it. Returns a problem or null. */
export function hostProblem(host: string): string | null {
    if (host === "")
        return "empty";
    if (/[\s()#,"]/.test(host))
        return "characters";
    if (host.startsWith("-"))
        return "dash";
    return null;
}
