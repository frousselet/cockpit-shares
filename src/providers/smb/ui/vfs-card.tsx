/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * VFS modules of a share (or of [global]): order, options and documentation.
 */

import React, { useMemo, useState } from "react";
import cockpit from "cockpit";

import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { DropdownItem } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Content } from "@patternfly/react-core/dist/esm/components/Content/index.js";
import { ExpandableSection } from "@patternfly/react-core/dist/esm/components/ExpandableSection/index.js";

import { useDialogs } from "dialogs";
import { ListingTable } from "cockpit-components-table";
import { KebabDropdown } from "cockpit-components-dropdown";
import { FormHelper } from "cockpit-components-form-helper";

import { useSmb } from "../state.tsx";
import { splitList, joinList, isGlobalSection, squashName } from "../smbconf.ts";
import { VFS_MODULES, getVfsModule, type VfsModule } from "../catalog.ts";
import { SambaDoc } from "../../../lib/doc.tsx";
import { DialogFrame, ConfirmDialog, useSubmit, reportSave, fallbackValue } from "./dialogs.tsx";
import { ParamField, validateParam, displayValue } from "./param-field.tsx";
import { useAccounts } from "./accounts.ts";

const _ = cockpit.gettext;

/** Options written when a module is added, following the Samba manual pages. */
export const MODULE_PRESETS: Record<string, [string, string][]> = {
    fruit: [["fruit:metadata", "stream"], ["fruit:encoding", "native"]],
    recycle: [["recycle:repository", ".recycle/%U"], ["recycle:keeptree", "yes"], ["recycle:versions", "yes"]],
    full_audit: [
        ["full_audit:prefix", "%u|%I|%S"],
        ["full_audit:success", "mkdirat renameat unlinkat"],
        ["full_audit:failure", "connect"],
        ["full_audit:facility", "LOCAL5"],
        ["full_audit:priority", "NOTICE"],
    ],
    shadow_copy2: [["shadow:snapdir", ".snapshots"], ["shadow:format", "@GMT-%Y.%m.%d-%H.%M.%S"], ["shadow:sort", "desc"]],
};

/** Modules fruit needs around it, in the order given by vfs_fruit(8). */
function insertModule(list: string[], module: string): string[] {
    if (list.includes(module))
        return list;
    if (module === "fruit") {
        const result = list.filter(m => m !== "catia" && m !== "streams_xattr");
        return [...result, "catia", "fruit", "streams_xattr"];
    }
    return [...list, module];
}

export function optionPrefixes(module: VfsModule): Set<string> {
    const prefixes = new Set<string>([squashName(module.name)]);
    for (const o of module.options)
        prefixes.add(squashName(o.name.split(":")[0]));
    return prefixes;
}

const AddModuleDialog = ({ section, current }: { section: string, current: string[] }) => {
    const smb = useSmb();
    const [module, setModule] = useState("");
    const { error, busy, submit } = useSubmit();
    const def = getVfsModule(module);
    const preset = MODULE_PRESETS[module] ?? [];

    const onSubmit = () => submit(async () => {
        const list = insertModule(current, module);
        const result = await smb.update(conf => {
            conf.set(section, "vfs objects", joinList(list));
            for (const [k, v] of preset)
                if (conf.get(section, k) === undefined)
                    conf.set(section, k, v, k);
        });
        reportSave(smb, result);
    });

    return (
        <DialogFrame id="smb-vfs-add" title={_("Add a VFS module")} error={error} isSubmitting={busy}
                     isDisabled={!module} submitLabel={_("Add")} onSubmit={onSubmit} variant="large"
        >
            <Form isHorizontal onSubmit={ev => { ev.preventDefault(); if (module) onSubmit(); }}>
                <FormGroup label={_("Module")} fieldId="smb-vfs-module" isRequired>
                    <FormSelect id="smb-vfs-module" value={module} onChange={(_ev, v) => setModule(v)}>
                        <FormSelectOption value="" label={_("Choose a module")} isPlaceholder />
                        {VFS_MODULES.filter(m => !current.includes(m.name)).map(m =>
                            <FormSelectOption key={m.name} value={m.name} label={`${m.name}: ${m.summary}`} />)}
                    </FormSelect>
                    <FormHelper fieldId="smb-vfs-module"
                                helperText={_("The module must be installed on this server; some are packaged separately (samba-vfs-modules, samba-vfs-glusterfs, ...).")}
                    />
                </FormGroup>
                {module === "fruit" &&
                    <Content component="p">{_("catia and streams_xattr are added as well, in the order required by fruit.")}</Content>}
                {preset.length > 0 &&
                    <FormGroup label={_("Options added")} fieldId="smb-vfs-preset">
                        <pre className="shares-preview" id="smb-vfs-preset">{preset.map(([k, v]) => `${k} = ${v}`).join("\n")}</pre>
                    </FormGroup>}
            </Form>
            {def?.doc &&
                <div className="shares-doc-panel"><SambaDoc html={def.doc} /></div>}
        </DialogFrame>
    );
};

const ModuleOptionsDialog = ({ section, module }: { section: string, module: VfsModule }) => {
    const smb = useSmb();
    const accounts = useAccounts();
    // options documented as global only are offered in the global settings only
    const options = module.options.filter(o => !o.global || isGlobalSection(section));
    const original = useMemo(() => Object.fromEntries(options.map(o => [o.name, smb.config.conf.get(section, o.name)])),
        // eslint-disable-next-line react-hooks/exhaustive-deps
                             []);
    const [values, setValues] = useState<Record<string, string | undefined>>(original);
    const { error, busy, submit } = useSubmit();
    const problems = Object.fromEntries(options.map(o => [o.name, validateParam(o.name, values[o.name])]));

    const onSubmit = () => submit(async () => {
        const changed = options.map(o => o.name).filter(n => values[n] !== original[n]);
        if (!changed.length)
            return;
        const result = await smb.update(conf => {
            for (const n of changed) {
                const v = values[n];
                if (v === undefined)
                    conf.unset(section, n);
                else
                    conf.set(section, n, v.trim(), n);
            }
        });
        reportSave(smb, result);
    });

    return (
        <DialogFrame id="smb-vfs-options" title={cockpit.format(_("Options of $0"), module.name)} error={error} isSubmitting={busy}
                     isDisabled={Object.values(problems).some(Boolean)} onSubmit={onSubmit} variant="large"
        >
            <Form isHorizontal onSubmit={ev => { ev.preventDefault(); onSubmit() }}>
                {options.map(o => {
                    const id = "smb-vfs-opt-" + o.name.replace(/\W+/g, "-");
                    return (
                        <FormGroup key={o.name} label={<code>{o.name}</code>} fieldId={id}>
                            <ParamField id={id} name={o.name} value={values[o.name]} accounts={accounts}
                                        fallback={fallbackValue(smb, section, o.name) ?? o.default_hint}
                                        unsetLabel={o.default_hint ? cockpit.format(_("Default ($0)"), o.default_hint) : _("Not set")}
                                        onChange={v => setValues(old => ({ ...old, [o.name]: v }))}
                            />
                            <FormHelper fieldId={id} helperTextInvalid={problems[o.name] ?? undefined}
                                        helperText={o.hint ? cockpit.format(_("Expected: $0"), o.hint) : undefined}
                            />
                            <ExpandableSection toggleText={_("Documentation")} className="shares-option-doc">
                                <SambaDoc html={o.doc} />
                            </ExpandableSection>
                        </FormGroup>
                    );
                })}
            </Form>
        </DialogFrame>
    );
};

export const VfsCard = ({ section }: { section: string }) => {
    const smb = useSmb();
    const Dialogs = useDialogs();
    const explicit = smb.config.conf.get(section, "vfs objects");
    const inherited = isGlobalSection(section) ? undefined : smb.inherited("vfs objects");
    const list = splitList(explicit ?? inherited ?? "");
    const isInherited = explicit === undefined && list.length > 0;
    const view = smb.config.conf.section(section);

    const write = async (newList: string[], removeOptionsOf?: VfsModule) => {
        const result = await smb.update(conf => {
            if (newList.length === 0 && isGlobalSection(section))
                conf.unset(section, "vfs objects");
            else
                conf.set(section, "vfs objects", joinList(newList));
            if (removeOptionsOf) {
                const prefixes = optionPrefixes(removeOptionsOf);
                for (const p of view?.parameters.values() ?? [])
                    if (p.name.includes(":") && prefixes.has(squashName(p.name.split(":")[0])))
                        conf.unset(section, p.name);
            }
        });
        reportSave(smb, result);
    };

    const rows = list.map((name, index) => {
        const module = getVfsModule(name);
        const prefixes = module ? optionPrefixes(module) : new Set([squashName(name)]);
        const options = Array.from(view?.parameters.values() ?? []).filter(p => p.name.includes(":") && prefixes.has(squashName(p.name.split(":")[0])));
        const move = (offset: number) => {
            const l = [...list];
            [l[index + offset], l[index]] = [l[index], l[index + offset]];
            write(l).catch(ex => smb.notify({ variant: "danger", title: ex.message }));
        };
        const confirmRemove = () => Dialogs.show(
            <ConfirmDialog id="smb-vfs-remove" title={cockpit.format(_("Remove module $0?"), name)}
                           body={options.length
                               ? cockpit.format(cockpit.ngettext("Its $0 option is removed as well.", "Its $0 options are removed as well.", options.length), options.length)
                               : _("The module is removed from vfs objects.")}
                           confirmLabel={_("Remove")}
                           onConfirm={() => write(list.filter(m => m !== name), module)} />);
        const actions = [];
        if (module && module.options.length)
            actions.push(<DropdownItem key="opts" onClick={() => Dialogs.show(<ModuleOptionsDialog section={section} module={module} />)}>{_("Options")}</DropdownItem>);
        if (index > 0)
            actions.push(<DropdownItem key="up" onClick={() => move(-1)}>{_("Move up")}</DropdownItem>);
        if (index < list.length - 1)
            actions.push(<DropdownItem key="down" onClick={() => move(1)}>{_("Move down")}</DropdownItem>);
        actions.push(<DropdownItem key="remove" className="pf-m-danger" onClick={confirmRemove}>{_("Remove")}</DropdownItem>);

        return {
            props: { key: name, "data-module": name },
            columns: [
                { title: <code>{name}</code> },
                { title: module?.summary ?? <Label color="orange" isCompact>{_("Not documented")}</Label> },
                {
                    title: options.length
                        ? <span className="shares-vfs-options">{options.map(o => `${o.name.split(":")[1]} = ${displayValue(o.name, o.value)}`).join(", ")}</span>
                        : "",
                },
                { title: smb.admin && !isInherited ? <KebabDropdown toggleButtonId={"vfs-actions-" + name} dropdownItems={actions} /> : null, props: { className: "pf-v6-c-table__action" } },
            ],
            expandedContent: module?.doc ? <SambaDoc html={module.doc} /> : undefined,
        };
    });

    return (
        <Card isPlain className="ct-card" id="smb-vfs">
            <CardHeader actions={{
                actions: smb.admin
                    ? (
                        <>
                            {isInherited &&
                                <Button variant="secondary" onClick={() => write(list).catch(ex => smb.notify({ variant: "danger", title: ex.message }))}>
                                    {_("Customize for this share")}
                                </Button>}
                            {!isInherited &&
                                <Button variant="secondary" id="smb-vfs-add-button" onClick={() => Dialogs.show(<AddModuleDialog section={section} current={list} />)}>
                                    {_("Add module")}
                                </Button>}
                        </>)
                    : null,
            }}
            >
                <CardTitle component="h2" className="shares-group-description">
                    {_("Modules add features such as a recycle bin, macOS support, snapshots or auditing. They run in the order of the list.")}
                </CardTitle>
            </CardHeader>
            {isInherited &&
                <CardBody>
                    <Content component="p">{_("This share uses the modules of the global settings.")}</Content>
                </CardBody>}
            <ListingTable aria-label={_("VFS modules")} variant="compact" gridBreakPoint="grid-md"
                          columns={[_("Module"), _("Purpose"), _("Options"), { title: "", props: { screenReaderText: _("Actions") } }]}
                          rows={rows}
                          emptyCaption={_("No VFS module")}
                          emptyCaptionDetail={_("Modules add features such as a recycle bin, macOS support, snapshots or auditing.")}
            />
        </Card>
    );
};
