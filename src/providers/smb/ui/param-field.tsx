/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Editor for a single smb.conf parameter, chosen from its type in the catalog.
 */

import React, { useState } from "react";
import cockpit from "cockpit";

import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { LabelGroup } from "@patternfly/react-core/dist/esm/components/Label/LabelGroup.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { Popover } from "@patternfly/react-core/dist/esm/components/Popover/index.js";
import { HelpIcon } from "@patternfly/react-icons";

import { TypeaheadSelect, type TypeaheadSelectOption } from "cockpit-components-typeahead-select";
import { FileAutoComplete } from "cockpit-components-file-autocomplete";

import { getParam, getVfsOption, canonicalEnumValue, SUBSTITUTIONS, type ParamDef, type VfsOption } from "../catalog.ts";
import { parseBoolean, splitList, joinList } from "../smbconf.ts";
import { SambaDoc } from "../../../lib/doc.tsx";
import type { FieldSpec } from "./labels.ts";
import type { Accounts } from "./accounts.ts";

const _ = cockpit.gettext;

export type FieldKind = FieldSpec["kind"];

export function definitionOf(name: string): ParamDef | VfsOption | undefined {
    return name.includes(":") ? getVfsOption(name)?.option : getParam(name);
}

export function booleanLabel(value: string | undefined): string {
    if (value === undefined)
        return "";
    const b = parseBoolean(value);
    return b === null ? value : (b ? _("Yes") : _("No"));
}

/** Text of a value for display, booleans translated. */
export function displayValue(name: string, value: string | undefined): string {
    if (value === undefined)
        return "";
    const def = definitionOf(name);
    if (def?.type === "boolean")
        return booleanLabel(value);
    return value;
}

export function defaultKind(name: string): FieldKind {
    if (["valid users", "invalid users", "read list", "write list", "admin users"].includes(name))
        return "principals";
    if (name === "hosts allow" || name === "hosts deny")
        return "hosts";
    if (name === "path")
        return "path";
    const def = definitionOf(name);
    if (def?.type === "octal")
        return "mode";
    return undefined;
}

/** Validation of a value against the catalog type. Returns a translated problem or null. */
export function validateParam(name: string, value: string | undefined): string | null {
    if (value === undefined)
        return null;
    if (/[\r\n]/.test(value))
        return _("Line breaks are not allowed.");
    if (/\\\s?$/.test(value))
        return _("A value cannot end with a backslash.");
    const def = definitionOf(name);
    if (!def)
        return null;
    switch (def.type) {
    case "boolean":
        return parseBoolean(value) === null ? _("Use yes or no.") : null;
    case "integer":
        return /^\s*-?\d+\s*$/.test(value) ? null : _("Enter a whole number.");
    case "bytes":
        return /^\s*\d+\s*[KMGTP]?B?\s*$/i.test(value) ? null : _("Enter a size, for example 1024, 512K or 2G.");
    case "octal":
        return /^\s*0?[0-7]{1,4}\s*$/.test(value) ? null : _("Enter an octal mode, for example 0644.");
    case "char":
        return value.length <= 1 ? null : _("Enter a single character.");
    case "enum":
        if (def.enum && def.enum.length > 0 && canonicalEnumValue(def, value) === null && "context" in def)
            return _("This value is not accepted by Samba.");
        return null;
    default:
        return null;
    }
}

/** "0750" -> "rwxr-x---" */
export function symbolicMode(mode: string): string {
    const m = mode.trim().replace(/^0(?=[0-7]{3,4}$)/, "");
    if (!/^[0-7]{3,4}$/.test(m))
        return "";
    const digits = m.slice(-3).split("")
            .map(Number);
    return digits.map(d => (d & 4 ? "r" : "-") + (d & 2 ? "w" : "-") + (d & 1 ? "x" : "-")).join("");
}

export const ParamHelp = ({ name, extra }: { name: string, extra?: React.ReactNode }) => {
    const def = definitionOf(name);
    const substitution = def && "substitution" in def && def.substitution;
    return (
        <Popover headerContent={<code>{def && "display" in def ? def.display : name}</code>}
                 hasAutoWidth maxWidth="40rem"
                 bodyContent={
                     <div className="shares-doc-popover">
                         {extra}
                         <SambaDoc html={def?.doc ?? ""} />
                         {substitution &&
                             <details className="shares-substitutions">
                                 <summary>{_("Variables accepted in this value")}</summary>
                                 <dl>
                                     {SUBSTITUTIONS.map(s => (
                                         <React.Fragment key={s.name}>
                                             <dt><code>{s.name}</code></dt>
                                             <dd><SambaDoc html={s.doc} /></dd>
                                         </React.Fragment>))}
                                 </dl>
                             </details>}
                     </div>
                 }
        >
            <Button variant="plain" isInline aria-label={cockpit.format(_("Documentation of $0"), name)}
                    className="pf-v6-c-form__group-label-help" icon={<HelpIcon />}
            />
        </Popover>
    );
};

const PrincipalsInput = ({ id, value, onChange, accounts }: {
    id: string,
    value: string | undefined,
    onChange: (v: string | undefined) => void,
    accounts: Accounts | null,
}) => {
    const items = splitList(value ?? "");
    const options: TypeaheadSelectOption[] = [];
    if (accounts) {
        options.push({ decorator: "header", content: _("Groups"), key: "h-groups" });
        for (const g of accounts.groups)
            if (!items.includes("@" + g.name))
                options.push({ value: "@" + g.name, content: "@" + g.name, description: _("Group") });
        options.push({ decorator: "divider", key: "d" });
        options.push({ decorator: "header", content: _("Users"), key: "h-users" });
        for (const u of accounts.regularUsers)
            if (!items.includes(u.name))
                options.push({ value: u.name, content: u.name, description: u.gecos || undefined });
    }
    const set = (list: string[]) => onChange(list.length ? joinList(list) : undefined);

    return (
        <Flex direction={{ default: "column" }} spaceItems={{ default: "spaceItemsSm" }}>
            {items.length > 0 &&
                <FlexItem>
                    <LabelGroup numLabels={20} id={id + "-items"}>
                        {items.map(i => (
                            <Label key={i} color={i.startsWith("@") || i.startsWith("+") || i.startsWith("&") ? "blue" : "grey"}
                                   onClose={() => set(items.filter(x => x !== i))}
                                   closeBtnAriaLabel={cockpit.format(_("Remove $0"), i)}
                            >
                                {i}
                            </Label>))}
                    </LabelGroup>
                </FlexItem>}
            <FlexItem>
                <TypeaheadSelect toggleProps={{ id }}
                                 selectOptions={options}
                                 placeholder={_("Add a user or a @group")}
                                 isCreatable
                                 createOptionMessage={(v: string) => cockpit.format(_("Add \"$0\""), v)}
                                 noOptionsFoundMessage={_("No matching account")}
                                 selected={null as unknown as string}
                                 onSelect={(_ev, selection) => {
                                     const v = String(selection).trim();
                                     if (v && !items.includes(v))
                                         set([...items, v]);
                                 }}
                />
            </FlexItem>
        </Flex>
    );
};

export interface ParamFieldProps {
    id: string;
    name: string;
    value: string | undefined;
    /** what applies when the parameter is not set */
    fallback?: string | undefined;
    onChange: (value: string | undefined) => void;
    kind?: FieldKind;
    accounts?: Accounts | null;
    /** wording of the "not set" choice */
    unsetLabel?: string;
    isDisabled?: boolean;
}

export const ParamField = ({ id, name, value, fallback, onChange, kind, accounts = null, unsetLabel, isDisabled = false }: ParamFieldProps) => {
    const def = definitionOf(name);
    const type = def?.type ?? "string";
    const k = kind ?? defaultKind(name);
    const fallbackText = fallback === undefined || fallback === ""
        ? _("not set")
        : displayValue(name, fallback);
    const unset = unsetLabel ?? cockpit.format(_("Default ($0)"), fallbackText);

    if (type === "boolean") {
        const b = value === undefined ? "" : (parseBoolean(value) === null ? value : (parseBoolean(value) ? "yes" : "no"));
        return (
            <FormSelect id={id} value={b} isDisabled={isDisabled} aria-label={name}
                        onChange={(_ev, v) => onChange(v === "" ? undefined : v)}
            >
                <FormSelectOption value="" label={unset} />
                <FormSelectOption value="yes" label={_("Yes")} />
                <FormSelectOption value="no" label={_("No")} />
                {b !== "" && b !== "yes" && b !== "no" && <FormSelectOption value={b} label={b} />}
            </FormSelect>
        );
    }

    if (type === "enum" && def?.enum && def.enum.length > 0) {
        const current = value === undefined ? "" : (canonicalEnumValue(def, value) ?? value);
        const known = def.enum.some(e => e.value === current);
        return (
            <FormSelect id={id} value={current} isDisabled={isDisabled} aria-label={name}
                        onChange={(_ev, v) => onChange(v === "" ? undefined : v)}
            >
                <FormSelectOption value="" label={unset} />
                {def.enum.map(e => <FormSelectOption key={e.value} value={e.value} label={e.value} />)}
                {current !== "" && !known && <FormSelectOption value={current} label={current} />}
            </FormSelect>
        );
    }

    if (k === "principals")
        return <PrincipalsInput id={id} value={value} onChange={onChange} accounts={accounts} />;

    if (k === "path") {
        return (
            <FileAutoComplete id={id} value={value ?? ""} onlyDirectories isOptionCreatable superuser="try"
                              placeholder={fallback || _("Directory path")}
                              onChange={(v: string) => onChange(v === "" ? undefined : v)}
            />
        );
    }

    return <TextParam id={id} name={name} value={value} fallback={fallback} onChange={onChange} kind={k} isDisabled={isDisabled} />;
};

const TextParam = ({ id, name, value, fallback, onChange, kind, isDisabled }: {
    id: string, name: string, value: string | undefined, fallback: string | undefined,
    onChange: (v: string | undefined) => void, kind: FieldKind, isDisabled: boolean,
}) => {
    const [text, setText] = useState(value ?? "");
    const problem = validateParam(name, text === "" ? undefined : text);
    const symbolic = kind === "mode" ? symbolicMode(text || fallback || "") : "";
    return (
        <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }} flexWrap={{ default: "nowrap" }}>
            <FlexItem grow={{ default: "grow" }}>
                <TextInput id={id} value={text} isDisabled={isDisabled} aria-label={name}
                           placeholder={fallback ?? ""}
                           validated={problem ? "error" : "default"}
                           onChange={(_ev, v) => { setText(v); onChange(v === "" ? undefined : v) }}
                />
            </FlexItem>
            {symbolic && <FlexItem><code className="shares-mode">{symbolic}</code></FlexItem>}
        </Flex>
    );
};
