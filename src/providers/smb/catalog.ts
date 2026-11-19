/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Typed access to the smb.conf parameter catalog generated from the Samba
 * documentation sources by tools/generate-smb-catalog.py.
 */

import data from "./smb-catalog.json" with { type: "json" };
import { normalizeKey, squashName, type KeyInfo, type KeyResolver } from "./smbconf.ts";

export type ParamType = "boolean" | "string" | "ustring" | "integer" | "bytes" | "octal" |
    "enum" | "list" | "cmdlist" | "char";

export interface EnumValue {
    value: string;
    aliases?: string[];
}

export interface ParamDef {
    name: string;
    display: string;
    /** "G": [global] only, "S": share parameter (also allowed in [global] as default) */
    context: "G" | "S";
    type: ParamType;
    category: string;
    default: string | null;
    examples?: string[];
    enum?: EnumValue[];
    synonyms?: string[];
    inverted_synonyms?: string[];
    related?: string[];
    deprecated?: boolean;
    substitution?: boolean;
    template?: { prefix: string, placeholder: string };
    doc: string;
}

export interface VfsOption {
    name: string;
    hint: string;
    type: ParamType;
    enum?: EnumValue[];
    default_hint?: string;
    /** only valid in [global] (vfs_fruit "GLOBAL OPTIONS") */
    global?: boolean;
    doc: string;
}

export interface VfsModule {
    name: string;
    summary: string;
    stackable?: boolean;
    doc?: string;
    options: VfsOption[];
}

export interface Substitution {
    name: string;
    doc: string;
}

interface CatalogData {
    samba_version: string;
    parameters: ParamDef[];
    vfs_modules: VfsModule[];
    substitutions: Substitution[];
}

const catalog = data as unknown as CatalogData;

export const CATALOG_SAMBA_VERSION = catalog.samba_version;
export const PARAMETERS: ParamDef[] = catalog.parameters.filter(p => !p.template);
export const PARAMETRIC_TEMPLATES: ParamDef[] = catalog.parameters.filter(p => p.template);
export const VFS_MODULES: VfsModule[] = catalog.vfs_modules;
export const SUBSTITUTIONS: Substitution[] = catalog.substitutions;

const byName = new Map<string, ParamDef>();
const aliasIndex = new Map<string, KeyInfo>();
const vfsOptionIndex = new Map<string, { module: VfsModule, option: VfsOption }>();

for (const p of PARAMETERS) {
    byName.set(p.name, p);
    aliasIndex.set(squashName(p.name), { name: p.name, inverted: false });
    for (const s of p.synonyms ?? [])
        aliasIndex.set(squashName(s), { name: p.name, inverted: false });
    for (const s of p.inverted_synonyms ?? [])
        aliasIndex.set(squashName(s), { name: p.name, inverted: true });
}

for (const m of VFS_MODULES)
    for (const o of m.options)
        if (!vfsOptionIndex.has(squashName(o.name)))
            vfsOptionIndex.set(squashName(o.name), { module: m, option: o });

/** Canonical name of a parametric option, "fruit : time machine" -> "fruit:time machine". */
export function normalizeParametric(key: string): string {
    const i = key.indexOf(":");
    return `${normalizeKey(key.slice(0, i))}:${normalizeKey(key.slice(i + 1))}`;
}

export function isParametric(key: string): boolean {
    return key.includes(":");
}

/** Resolver used by SmbConf: maps every spelling and synonym to the canonical parameter. */
export const catalogResolver: KeyResolver = (key: string) => {
    if (isParametric(key)) {
        // parametric options are matched ignoring case and whitespace as well
        const known = vfsOptionIndex.get(squashName(key));
        return { name: known ? known.option.name.toLowerCase() : normalizeParametric(key), inverted: false };
    }
    return aliasIndex.get(squashName(key)) ?? { name: normalizeKey(key), inverted: false };
};

export function getParam(name: string): ParamDef | undefined {
    return byName.get(catalogResolver(name).name);
}

export function getVfsOption(name: string): { module: VfsModule, option: VfsOption } | undefined {
    return vfsOptionIndex.get(squashName(name));
}

export function getVfsModule(name: string): VfsModule | undefined {
    return VFS_MODULES.find(m => m.name === name);
}

export function parametricTemplate(key: string): ParamDef | undefined {
    if (!isParametric(key))
        return undefined;
    const prefix = squashName(key.slice(0, key.indexOf(":")));
    return PARAMETRIC_TEMPLATES.find(t => squashName(t.template!.prefix) === prefix &&
        squashName(t.name) === squashName(key));
}

/** Parameters valid in a share section. */
export function shareParameters(): ParamDef[] {
    return PARAMETERS.filter(p => p.context === "S");
}

/** Parameters valid in [global]: every global parameter plus share defaults. */
export function globalParameters(): ParamDef[] {
    return PARAMETERS;
}

/** Canonical spelling of an enum value, e.g. "bad user" -> "Bad User", "yes" -> "if_required". */
export function canonicalEnumValue(def: ParamDef | VfsOption, value: string): string | null {
    const v = squashName(value);
    for (const e of def.enum ?? []) {
        if (squashName(e.value) === v)
            return e.value;
        if ((e.aliases ?? []).some(a => squashName(a) === v))
            return e.value;
    }
    return null;
}

/** Category labels are translated in the UI (see ui/labels.ts). */
export const CATEGORIES = Array.from(new Set(PARAMETERS.map(p => p.category))).sort();
