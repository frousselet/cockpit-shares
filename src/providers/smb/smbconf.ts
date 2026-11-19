/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Lossless smb.conf reader and editor.
 *
 * The rules follow Samba's own parser (lib/util/tini.c and lib/param/loadparm.c):
 *  - a line whose first non blank character is '#' or ';' is a comment
 *    (there are no trailing comments: '#' after a value is part of the value)
 *  - a line ending in '\' (optionally followed by one blank) continues on the next one
 *  - "[name]" starts a section, everything after the first ']' is ignored
 *  - "name = value" is split on the first '='; lines without '=' are ignored
 *  - parameter and section names are compared ignoring case and all whitespace
 *  - parameters found before the first section belong to [global]
 *  - a section may appear several times, the definitions are merged and the last
 *    occurrence of a parameter wins
 *
 * Untouched lines are written back byte for byte, so comments, ordering, blank
 * lines and the original spelling of every key are preserved.
 *
 * This module has no dependency on Cockpit so that it can be unit tested with node.
 */

export type LineKind = "blank" | "comment" | "section" | "param" | "other";

export interface ConfLine {
    kind: LineKind;
    /** physical lines exactly as read, joined with "\n" (continuations included) */
    raw: string;
    /** section name for "section" lines */
    section?: string;
    /** key as written for "param" lines (whitespace collapsed, trimmed) */
    key?: string;
    /** value for "param" lines, with continuations joined like Samba does */
    value?: string;
}

export interface KeyInfo {
    /** canonical parameter name, lower case, single spaces */
    name: string;
    /** true when the key is an inverted boolean synonym, e.g. "writeable" for "read only" */
    inverted: boolean;
}

/** Maps a key as written in the file to its canonical parameter. */
export type KeyResolver = (key: string) => KeyInfo;

export const GLOBAL = "global";

/** Samba's strwicmp(): compare ignoring case and every whitespace character. */
export function squashName(name: string): string {
    return name.replace(/\s+/g, "").toLowerCase();
}

export function sameName(a: string, b: string): boolean {
    return squashName(a) === squashName(b);
}

export function isGlobalSection(name: string): boolean {
    const n = squashName(name);
    return n === "global" || n === "globals";
}

/** Normalize a key for display or as a fallback canonical name. */
export function normalizeKey(key: string): string {
    return key.trim().replace(/\s+/g, " ")
            .toLowerCase();
}

export const defaultResolver: KeyResolver = key => ({ name: normalizeKey(key), inverted: false });

const TRUE_WORDS = ["yes", "true", "on", "1"];
const FALSE_WORDS = ["no", "false", "off", "0"];

/** Samba's set_boolean(). Returns null when the string is not a boolean. */
export function parseBoolean(value: string): boolean | null {
    const v = squashName(value);
    if (TRUE_WORDS.includes(v))
        return true;
    if (FALSE_WORDS.includes(v))
        return false;
    return null;
}

export function invertBooleanString(value: string): string {
    const b = parseBoolean(value);
    if (b === null)
        return value;
    return b ? "no" : "yes";
}

function collapse(s: string): string {
    // tini.c zaps every run of whitespace into a single character
    return s.replace(/\s+/g, " ");
}

function trimOne(s: string): string {
    // after collapsing there is at most one blank on each side
    return s.trim();
}

/** Split text into logical lines (continuations joined), keeping the raw text. */
function splitLogical(text: string): { raw: string, logical: string }[] {
    const physical = text.split(/\r?\n/);
    // a trailing newline produces an empty last element that is not a line
    if (physical.length > 0 && physical[physical.length - 1] === "")
        physical.pop();

    const result: { raw: string, logical: string }[] = [];
    let i = 0;
    while (i < physical.length) {
        const first = physical[i];
        const trimmed = first.replace(/^\s+/, "");
        // comments and blank lines never continue
        if (trimmed === "" || trimmed[0] === "#" || trimmed[0] === ";") {
            result.push({ raw: first, logical: first });
            i++;
            continue;
        }
        const rawParts = [first];
        let logical = "";
        let current = first;
        for (;;) {
            const m = current.match(/\\\s?$/);
            if (m && i + 1 < physical.length) {
                logical += current.slice(0, current.length - m[0].length);
                i++;
                current = physical[i];
                rawParts.push(current);
                continue;
            }
            logical += current;
            break;
        }
        result.push({ raw: rawParts.join("\n"), logical });
        i++;
    }
    return result;
}

export function parseLine(raw: string, logical: string = raw): ConfLine {
    const text = logical.replace(/^\s+/, "");
    if (text.trim() === "")
        return { kind: "blank", raw };
    if (text[0] === "#" || text[0] === ";")
        return { kind: "comment", raw };
    const line = collapse(text);
    if (line[0] === "[") {
        const end = line.indexOf("]");
        if (end < 0)
            return { kind: "other", raw };
        return { kind: "section", raw, section: line.slice(1, end).trim() };
    }
    const eq = line.indexOf("=");
    if (eq < 0)
        return { kind: "other", raw };
    const key = trimOne(line.slice(0, eq));
    if (key === "")
        return { kind: "other", raw };
    return { kind: "param", raw, key, value: trimOne(line.slice(eq + 1)) };
}

export interface ConfBlock {
    /** null for the implicit global block before the first section header */
    header: ConfLine | null;
    lines: ConfLine[];
}

export interface Parameter {
    /** canonical name */
    name: string;
    /** effective value, already inverted for inverted synonyms */
    value: string;
    /** key as written in the file */
    key: string;
    /** raw value as written in the file */
    rawValue: string;
    inverted: boolean;
}

export interface SectionView {
    /** name as written in the first header */
    name: string;
    /** effective parameters in file order, keyed by canonical name (last occurrence wins) */
    parameters: Map<string, Parameter>;
}

export class SmbConf {
    blocks: ConfBlock[];
    resolver: KeyResolver;
    eol: string;
    trailingNewline: boolean;

    constructor(blocks: ConfBlock[], resolver: KeyResolver, eol = "\n", trailingNewline = true) {
        this.blocks = blocks;
        this.resolver = resolver;
        this.eol = eol;
        this.trailingNewline = trailingNewline;
    }

    static parse(text: string, resolver: KeyResolver = defaultResolver): SmbConf {
        const eol = text.includes("\r\n") ? "\r\n" : "\n";
        const trailingNewline = text === "" || /\n$/.test(text);
        const blocks: ConfBlock[] = [{ header: null, lines: [] }];
        for (const { raw, logical } of splitLogical(text)) {
            const line = parseLine(raw, logical);
            if (line.kind === "section")
                blocks.push({ header: line, lines: [] });
            else
                blocks[blocks.length - 1].lines.push(line);
        }
        return new SmbConf(blocks, resolver, eol, trailingNewline);
    }

    toString(): string {
        const out: string[] = [];
        for (const block of this.blocks) {
            if (block.header)
                out.push(block.header.raw);
            for (const line of block.lines)
                out.push(line.raw);
        }
        let text = out.join("\n");
        if (this.eol !== "\n")
            text = text.replace(/\n/g, this.eol);
        if (out.length > 0 && this.trailingNewline)
            text += this.eol;
        return text;
    }

    clone(): SmbConf {
        return SmbConf.parse(this.toString(), this.resolver);
    }

    blockName(block: ConfBlock): string {
        return block.header ? block.header.section! : GLOBAL;
    }

    /** All blocks of a section, the implicit leading block counts as [global]. */
    blocksOf(section: string): ConfBlock[] {
        const global = isGlobalSection(section);
        return this.blocks.filter(b => b.header === null
            ? global
            : (global ? isGlobalSection(b.header.section!) : sameName(b.header.section!, section)));
    }

    hasSection(section: string): boolean {
        if (isGlobalSection(section))
            return true;
        return this.blocksOf(section).length > 0;
    }

    /** Section names in file order, without duplicates, [global] excluded. */
    sectionNames(): string[] {
        const seen = new Set<string>();
        const names: string[] = [];
        for (const b of this.blocks) {
            if (!b.header || isGlobalSection(b.header.section!))
                continue;
            const k = squashName(b.header.section!);
            if (!seen.has(k)) {
                seen.add(k);
                names.push(b.header.section!);
            }
        }
        return names;
    }

    private resolve(key: string): KeyInfo {
        return this.resolver(key);
    }

    section(section: string): SectionView | null {
        const blocks = this.blocksOf(section);
        if (blocks.length === 0 && !isGlobalSection(section))
            return null;
        const parameters = new Map<string, Parameter>();
        for (const block of blocks) {
            for (const line of block.lines) {
                if (line.kind !== "param")
                    continue;
                const info = this.resolve(line.key!);
                const value = info.inverted ? invertBooleanString(line.value!) : line.value!;
                // delete first so that the Map keeps the order of the winning occurrence
                parameters.delete(info.name);
                parameters.set(info.name, { name: info.name, value, key: line.key!, rawValue: line.value!, inverted: info.inverted });
            }
        }
        const first = blocks.find(b => b.header);
        return { name: first ? first.header!.section! : (isGlobalSection(section) ? GLOBAL : section), parameters };
    }

    get(section: string, name: string): string | undefined {
        const info = this.resolve(name);
        const value = this.section(section)?.parameters.get(info.name)?.value;
        return value !== undefined && info.inverted ? invertBooleanString(value) : value;
    }

    private matching(block: ConfBlock, name: string): ConfLine[] {
        const canonical = this.resolve(name).name;
        return block.lines.filter(l => l.kind === "param" && this.resolve(l.key!).name === canonical);
    }

    private indentOf(blocks: ConfBlock[]): string {
        for (const b of blocks) {
            for (const l of b.lines) {
                if (l.kind === "param") {
                    const m = l.raw.match(/^[ \t]*/);
                    return m ? m[0] : "\t";
                }
            }
        }
        // look at any section of the file for the house style
        for (const b of this.blocks) {
            for (const l of b.lines) {
                if (l.kind === "param" && b.header)
                    return l.raw.match(/^[ \t]*/)![0];
            }
        }
        return "\t";
    }

    private makeParam(indent: string, key: string, value: string): ConfLine {
        const raw = `${indent}${key} = ${value}`;
        return parseLine(raw);
    }

    /**
     * Set a parameter. The last existing occurrence (under any synonym) is
     * rewritten in place with the canonical key; otherwise a new line is added
     * after the last parameter of the section, creating the section if needed.
     */
    set(section: string, name: string, value: string, displayKey?: string): void {
        validateValue(value);
        const target = this.resolve(name);
        if (target.inverted)
            value = invertBooleanString(value);
        const canonical = target.name;
        const key = displayKey ?? canonical;
        let blocks = this.blocksOf(section);
        const explicitGlobal = isGlobalSection(section) && blocks.some(b => b.header);
        const implicitParams = isGlobalSection(section) && blocks.some(b => !b.header && b.lines.some(l => l.kind === "param"));
        if (blocks.length === 0 || (isGlobalSection(section) && !explicitGlobal && !implicitParams)) {
            this.addSection(section);
            blocks = this.blocksOf(section);
        }
        const indent = this.indentOf(blocks);

        let last: { block: ConfBlock, index: number } | null = null;
        for (const block of blocks)
            block.lines.forEach((l, index) => {
                if (l.kind === "param" && this.resolve(l.key!).name === canonical)
                    last = { block, index };
            });

        if (last) {
            const { block, index } = last as { block: ConfBlock, index: number };
            const old = block.lines[index];
            const info = this.resolve(old.key!);
            // keep the line untouched when it already says the same thing
            const current = info.inverted ? invertBooleanString(old.value!) : old.value!;
            if (current === value && !info.inverted)
                return;
            const oldIndent = old.raw.match(/^[ \t]*/)![0];
            const keepKey = !info.inverted && normalizeKey(old.key!) === canonical ? old.key! : key;
            block.lines[index] = this.makeParam(oldIndent, keepKey, value);
            return;
        }

        // append after the last parameter of the last block of this section
        const block = blocks[blocks.length - 1];
        let pos = -1;
        block.lines.forEach((l, i) => { if (l.kind === "param") pos = i; });
        if (pos < 0) {
            // no parameter yet: put it right after the header, before comments
            // that separate this section from the next one
            pos = leadingContentEnd(block);
        }
        block.lines.splice(pos + 1, 0, this.makeParam(indent, key, value));
    }

    /** Remove every occurrence of a parameter (and its synonyms) from a section. */
    unset(section: string, name: string): boolean {
        let removed = false;
        for (const block of this.blocksOf(section)) {
            const matches = new Set(this.matching(block, name));
            if (matches.size) {
                removed = true;
                block.lines = block.lines.filter(l => !matches.has(l));
            }
        }
        return removed;
    }

    /**
     * Replace the parameters of a section by the given ones.
     * Parameters present in both keep their line, the others are added or removed.
     */
    setSection(section: string, params: Map<string, string> | Record<string, string>, displayKeys?: Map<string, string>): void {
        const wanted = params instanceof Map ? params : new Map(Object.entries(params));
        const current = this.section(section);
        if (current) {
            for (const name of current.parameters.keys())
                if (!wanted.has(name))
                    this.unset(section, name);
        }
        for (const [name, value] of wanted)
            this.set(section, name, value, displayKeys?.get(name));
    }

    addSection(section: string): void {
        if (isGlobalSection(section)) {
            if (!this.blocks.some(b => b.header && isGlobalSection(b.header.section!))) {
                // [global] goes before the first share
                const header = parseLine(`[${GLOBAL}]`);
                const index = this.blocks.findIndex(b => b.header !== null);
                const block = { header, lines: [parseLine("")] };
                if (index < 0)
                    this.blocks.push(block);
                else
                    this.blocks.splice(index, 0, block);
            }
            return;
        }
        if (this.blocksOf(section).length > 0)
            throw new Error(`section [${section}] already exists`);
        validateSectionName(section);
        const lastBlock = this.blocks[this.blocks.length - 1];
        const lastLine = lastBlock.lines[lastBlock.lines.length - 1];
        if ((lastBlock.header || lastBlock.lines.length > 0) && lastLine?.kind !== "blank")
            lastBlock.lines.push(parseLine(""));
        this.blocks.push({ header: parseLine(`[${section}]`), lines: [] });
    }

    renameSection(from: string, to: string): void {
        if (isGlobalSection(from) || isGlobalSection(to))
            throw new Error("the [global] section cannot be renamed");
        validateSectionName(to);
        if (!sameName(from, to) && this.blocksOf(to).length > 0)
            throw new Error(`section [${to}] already exists`);
        for (const block of this.blocksOf(from)) {
            const raw = block.header!.raw;
            const m = raw.match(/^(\s*\[)([^\]]*)(\].*)$/s);
            block.header = parseLine(m ? `${m[1]}${to}${m[3]}` : `[${to}]`);
        }
    }

    /**
     * Remove a section. Comment lines glued to its header (no blank line in
     * between) go with it, and so do its own lines, except a trailing comment
     * block glued to the next header, which documents the next section.
     */
    removeSection(section: string): void {
        if (isGlobalSection(section))
            throw new Error("the [global] section cannot be removed");
        const targets = new Set(this.blocksOf(section));
        if (targets.size === 0)
            return;
        const result: ConfBlock[] = [];
        const touched = new Set<ConfBlock>();
        for (let i = 0; i < this.blocks.length; i++) {
            const block = this.blocks[i];
            if (!targets.has(block)) {
                result.push(block);
                continue;
            }
            const prev = result[result.length - 1];
            if (prev) {
                touched.add(prev);
                // a comment block separated from the previous content by a blank
                // line and glued to our header documents our section: drop it
                let j = prev.lines.length;
                while (j > 0 && prev.lines[j - 1].kind === "comment")
                    j--;
                if (j > 0 && j < prev.lines.length && prev.lines[j - 1].kind === "blank")
                    prev.lines.splice(j);
            }
            // a trailing comment block separated from our content by a blank line
            // and glued to the next header documents the next section: keep it
            const next = this.blocks[i + 1];
            if (next && !targets.has(next) && prev) {
                let k = block.lines.length;
                while (k > 0 && block.lines[k - 1].kind === "comment")
                    k--;
                if (k > 0 && k < block.lines.length && block.lines[k - 1].kind === "blank") {
                    const lastPrev = prev.lines[prev.lines.length - 1];
                    if (lastPrev && lastPrev.kind !== "blank")
                        prev.lines.push(parseLine(""));
                    prev.lines.push(...block.lines.slice(k));
                }
            }
        }
        const removedLast = targets.has(this.blocks[this.blocks.length - 1]);
        this.blocks = result;
        if (removedLast) {
            const last = this.blocks[this.blocks.length - 1];
            while (last.lines.length && last.lines[last.lines.length - 1].kind === "blank")
                last.lines.pop();
        }
        // avoid piling up blank lines where the section was
        for (const block of touched) {
            let end = block.lines.length;
            while (end > 1 && block.lines[end - 1].kind === "blank" && block.lines[end - 2].kind === "blank")
                end--;
            block.lines.splice(end);
        }
    }

    /** Raw text of one section (all its blocks), handy for previews. */
    sectionText(section: string): string {
        const out: string[] = [];
        for (const block of this.blocksOf(section)) {
            if (block.header)
                out.push(block.header.raw);
            for (const line of block.lines)
                out.push(line.raw);
        }
        return out.join("\n");
    }
}

/** Index of the last line that belongs to the section header (leading comments), -1 if none. */
function leadingContentEnd(block: ConfBlock): number {
    let i = 0;
    while (i < block.lines.length && block.lines[i].kind !== "blank")
        i++;
    return i - 1;
}

export class ValidationError extends Error {}

export function validateValue(value: string): void {
    if (/[\r\n]/.test(value))
        throw new ValidationError("values cannot contain line breaks");
    if (/\\\s?$/.test(value))
        throw new ValidationError("values cannot end with a backslash, Samba would read it as a line continuation");
}

/** Share names: no brackets, no control characters, at most 80 characters as Windows clients expect. */
export function shareNameProblem(name: string): string | null {
    if (name.trim() === "")
        return "empty";
    if (name !== name.trim())
        return "spaces";
    if (/[[\]]/.test(name))
        return "brackets";
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(name))
        return "control";
    if (/["/\\:|<>+=;,*?]/.test(name))
        return "reserved";
    if (name.length > 80)
        return "length";
    if (isGlobalSection(name))
        return "global";
    return null;
}

export function validateSectionName(name: string): void {
    const problem = shareNameProblem(name);
    // printers/homes are fine, only syntax problems are fatal here
    if (problem && problem !== "reserved" && problem !== "length")
        throw new ValidationError(`invalid section name "${name}": ${problem}`);
}

/**
 * Split a Samba list value. Samba separates list items by blanks or commas and
 * accepts double quotes around an item that contains blanks.
 */
export function splitList(value: string): string[] {
    // same as next_token(): quotes are removed and protect separators
    const items: string[] = [];
    let current = "";
    let quoted = false;
    let started = false;
    for (const c of value) {
        if (c === '"') {
            quoted = !quoted;
            started = true;
        } else if (!quoted && (c === "," || /\s/.test(c))) {
            if (started && current !== "")
                items.push(current);
            current = "";
            started = false;
        } else {
            current += c;
            started = true;
        }
    }
    if (current !== "")
        items.push(current);
    return items;
}

export function joinList(items: string[], separator = " "): string {
    return items.map(i => (/[\s,]/.test(i) ? `"${i}"` : i)).join(separator);
}
