/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Every smb.conf parameter of a section: the ones set in the file, and on
 * demand every parameter known to Samba with its inherited or default value.
 */

import React, { useMemo, useState } from "react";
import cockpit from "cockpit";

import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { SearchInput } from "@patternfly/react-core/dist/esm/components/SearchInput/index.js";
import { ToggleGroup, ToggleGroupItem } from "@patternfly/react-core/dist/esm/components/ToggleGroup/index.js";
import { Toolbar, ToolbarContent, ToolbarItem } from "@patternfly/react-core/dist/esm/components/Toolbar/index.js";
import { DropdownItem } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { Tooltip } from "@patternfly/react-core/dist/esm/components/Tooltip/index.js";
import { SearchIcon } from "@patternfly/react-icons";

import { useDialogs } from "dialogs";
import { ListingTable } from "cockpit-components-table";
import { KebabDropdown } from "cockpit-components-dropdown";
import { EmptyStatePanel } from "cockpit-components-empty-state";

import { useSmb } from "../state.tsx";
import { isGlobalSection } from "../smbconf.ts";
import { PARAMETERS, CATEGORIES, getParam, getVfsOption, isParametric, type ParamDef } from "../catalog.ts";
import { SambaDoc } from "../../../lib/doc.tsx";
import { categoryLabel } from "./labels.ts";
import { displayValue } from "./param-field.tsx";
import { ParamEditDialog, AddParamDialog, ConfirmDialog, fallbackValue, reportSave } from "./dialogs.tsx";

const _ = cockpit.gettext;

interface Row {
    name: string;
    def: ParamDef | undefined;
    category: string;
    value: string | undefined;
    key: string | undefined;
    inverted: boolean;
    doc: string;
}

const PAGE = 100;

export const ParameterTable = ({ section, title }: { section: string, title?: string }) => {
    const smb = useSmb();
    const Dialogs = useDialogs();
    const [mode, setMode] = useState<"set" | "all">("set");
    const [filter, setFilter] = useState("");
    const [category, setCategory] = useState("");
    const [limit, setLimit] = useState(PAGE);
    const global = isGlobalSection(section);
    const view = smb.config.conf.section(section);

    const rows = useMemo(() => {
        const set = view?.parameters ?? new Map();
        const result: Row[] = [];
        const seen = new Set<string>();
        for (const p of set.values()) {
            const def = getParam(p.name);
            const vfs = isParametric(p.name) ? getVfsOption(p.name) : undefined;
            seen.add(p.name);
            result.push({
                name: p.name,
                def,
                category: def?.category ?? (isParametric(p.name) ? "parametric" : "unknown"),
                value: p.value,
                key: p.key,
                inverted: p.inverted,
                doc: def?.doc ?? vfs?.option.doc ?? "",
            });
        }
        if (mode === "all") {
            for (const def of PARAMETERS) {
                if (seen.has(def.name) || (!global && def.context === "G"))
                    continue;
                result.push({ name: def.name, def, category: def.category, value: undefined, key: undefined, inverted: false, doc: def.doc });
            }
        }
        return result.sort((a, b) => a.name.localeCompare(b.name));
    }, [view, mode, global]);

    const f = filter.trim().toLowerCase();
    const filtered = rows.filter(r => (!category || r.category === category) &&
        (!f || r.name.includes(f) || (r.value ?? "").toLowerCase().includes(f) ||
         (r.def?.synonyms ?? []).some(s => s.includes(f)) || (f.length > 3 && r.doc.toLowerCase().includes(f))));
    const shown = filtered.slice(0, limit);

    const reset = (name: string) => Dialogs.show(
        <ConfirmDialog id="smb-param-reset" title={cockpit.format(_("Reset $0?"), name)}
                       body={global
                           ? _("The line is removed from smb.conf and the built-in default of Samba applies.")
                           : _("The line is removed from this share, which then uses the value of the global settings.")}
                       confirmLabel={_("Reset")} isDanger={false}
                       onConfirm={async () => {
                           const result = await smb.update(conf => { conf.unset(section, name) });
                           reportSave(smb, result, global ? [name] : []);
                       }}
        />);

    const tableRows = shown.map(r => {
        const fallback = fallbackValue(smb, section, r.name);
        const labels = [];
        if (r.def?.deprecated)
            labels.push(<Label key="dep" color="orange" isCompact>{_("Deprecated")}</Label>);
        if (r.category === "unknown")
            labels.push(
                <Tooltip key="unk" content={_("This parameter is not documented by Samba; testparm ignores unknown parameters.")}>
                    <Label color="red" isCompact>{_("Unknown")}</Label>
                </Tooltip>);
        if (!global && (r.def?.context === "G" || (isParametric(r.name) && getVfsOption(r.name)?.option.global)) && r.value !== undefined)
            labels.push(
                <Tooltip key="glob" content={_("Global parameter found in a share section: Samba ignores it here.")}>
                    <Label color="red" isCompact>{_("Global only")}</Label>
                </Tooltip>);
        if (r.key && r.key.toLowerCase().replace(/\s+/g, " ") !== r.name && !isParametric(r.name))
            labels.push(<Label key="syn" isCompact variant="outline">{cockpit.format(_("written as $0"), r.key)}</Label>);

        const actions = [
            <DropdownItem key="edit" onClick={() => Dialogs.show(<ParamEditDialog section={section} name={r.name} />)}>
                {_("Edit")}
            </DropdownItem>,
        ];
        if (r.value !== undefined)
            actions.push(
                <DropdownItem key="reset" onClick={() => reset(r.name)}>
                    {global ? _("Reset to default") : _("Use the global value")}
                </DropdownItem>);

        return {
            props: { key: r.name, "data-param": r.name },
            columns: [
                {
                    title: (
                        <span className="shares-param-cell">
                            <Button variant="link" isInline isDisabled={!smb.admin}
                                    onClick={() => Dialogs.show(<ParamEditDialog section={section} name={r.name} />)}
                            >
                                <code>{r.name}</code>
                            </Button>
                            {labels}
                        </span>),
                    sortKey: r.name,
                },
                {
                    title: r.value !== undefined
                        ? <span className="shares-param-value">{displayValue(r.name, r.value) || <em>{_("empty")}</em>}</span>
                        : <span className="shares-param-fallback">{displayValue(r.name, fallback)}</span>,
                },
                {
                    title: r.value !== undefined
                        ? <span className="shares-param-fallback">{displayValue(r.name, fallback)}</span>
                        : "",
                },
                { title: categoryLabel(r.category) },
                {
                    title: smb.admin ? <KebabDropdown toggleButtonId={"param-actions-" + r.name.replace(/\W+/g, "-")} dropdownItems={actions} /> : null,
                    props: { className: "pf-v6-c-table__action" },
                },
            ],
            expandedContent: <SambaDoc html={r.doc} />,
        };
    });

    const exclude = new Set(Array.from(view?.parameters.keys() ?? []));

    const toolbar = (
        <Toolbar>
            <ToolbarContent>
                <ToolbarItem>
                    <SearchInput placeholder={_("Search parameters")} value={filter} aria-label={_("Search parameters")}
                                     onChange={(_ev, v) => { setFilter(v); setLimit(PAGE) }} onClear={() => setFilter("")}
                    />
                </ToolbarItem>
                <ToolbarItem>
                    <FormSelect value={category} aria-label={_("Category")}
                                    onChange={(_ev, v) => { setCategory(v); setLimit(PAGE) }}
                    >
                        <FormSelectOption value="" label={_("All categories")} />
                        {[...CATEGORIES, "parametric", "unknown"].map(c =>
                            <FormSelectOption key={c} value={c} label={categoryLabel(c)} />)}
                    </FormSelect>
                </ToolbarItem>
                <ToolbarItem>
                    <ToggleGroup aria-label={_("Parameters to show")}>
                        <ToggleGroupItem text={_("Set here")} buttonId="params-set" isSelected={mode === "set"}
                                             onChange={() => setMode("set")}
                        />
                        <ToggleGroupItem text={_("All")} buttonId="params-all" isSelected={mode === "all"}
                                             onChange={() => { setMode("all"); setLimit(PAGE) }}
                        />
                    </ToggleGroup>
                </ToolbarItem>
                {smb.admin &&
                <ToolbarItem align={{ default: "alignEnd" }}>
                    <Button variant="secondary" id="smb-param-add-button"
                                    onClick={() => Dialogs.show(<AddParamDialog section={section} exclude={exclude} />)}
                    >
                        {_("Add a parameter")}
                    </Button>
                </ToolbarItem>}
            </ToolbarContent>
        </Toolbar>
    );

    return (
        <Card isPlain className="ct-card" id={"smb-params-" + (global ? "global" : "share")}>
            {title
                ? (
                    <CardHeader actions={{ actions: toolbar }}>
                        <CardTitle component="h2">{title}</CardTitle>
                    </CardHeader>)
                : <CardHeader>{toolbar}</CardHeader>}
            <ListingTable aria-label={title ?? _("All parameters")} variant="compact" gridBreakPoint="grid-md"
                          className="shares-param-table"
                          columns={[
                              { title: _("Parameter") },
                              { title: _("Value") },
                              { title: global ? _("Default") : _("Inherited") },
                              { title: _("Category") },
                              { title: "", props: { screenReaderText: _("Actions") } },
                          ]}
                          rows={tableRows}
                          isEmptyStateInTable
                          emptyComponent={f || category
                              ? <EmptyStatePanel icon={SearchIcon} title={_("No matching parameters")}
                                                 action={_("Clear filters")} actionVariant="link"
                                                 onAction={() => { setFilter(""); setCategory("") }}
                              />
                              : <EmptyStatePanel title={_("No parameter is set here")}
                                                 paragraph={_("Select \"All\" to see every parameter with the value that applies.")}
                              />}
            />
            {filtered.length > shown.length &&
                <div className="shares-more">
                    <Button variant="link" onClick={() => setLimit(filtered.length)}>
                        {cockpit.format(_("Show all $0 parameters"), filtered.length)}
                    </Button>
                </div>}
        </Card>
    );
};
