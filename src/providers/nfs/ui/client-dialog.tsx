/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Client of an export (host and every export option), or the default options
 * of an export line.
 */

import React, { useEffect, useState } from "react";
import cockpit from "cockpit";

import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import { Form, FormGroup, FormSection } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { LabelGroup } from "@patternfly/react-core/dist/esm/components/Label/LabelGroup.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { Popover } from "@patternfly/react-core/dist/esm/components/Popover/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { HelpIcon } from "@patternfly/react-icons";

import { FormHelper } from "cockpit-components-form-helper";
import { TypeaheadSelect, type TypeaheadSelectOption } from "cockpit-components-typeahead-select";

import { useNfs } from "../state.tsx";
import { hostProblem, type ExportEntry, type ClientItem } from "../exports.ts";
import { localNetworks } from "../backend.ts";
import { DialogFrame, useSubmit } from "../../smb/ui/dialogs.tsx";
import {
    EXPORT_OPTIONS, readOption, writeOption, otherOptions, isKnownOption, groupLabel, choiceLabel,
    type ExportOption, type OptionGroup,
} from "./options.ts";

const _ = cockpit.gettext;

const OptionHelp = ({ opt }: { opt: ExportOption }) => (
    <Popover headerContent={opt.label()} bodyContent={<div><p>{opt.help()}</p><p><code>{opt.kind === "choice" ? opt.values.map(v => v.token).join(" | ") : opt.id}</code></p></div>}>
        <Button variant="plain" isInline aria-label={cockpit.format(_("Help about $0"), opt.label())} icon={<HelpIcon />}
                className="pf-v6-c-form__group-label-help" />
    </Popover>
);

/** Editor of one option of the catalog. `inherited` is the value applying when the option is not written. */
const OptionField = ({ opt, options, inherited, onChange }: {
    opt: ExportOption,
    options: string[],
    inherited: string | null,
    onChange: (options: string[]) => void,
}) => {
    const id = "nfs-opt-" + opt.id;
    const value = readOption(options, opt);

    if (opt.kind === "choice") {
        const dflt = choiceLabel(opt, inherited);
        return (
            <FormSelect id={id} value={value ?? ""} aria-label={opt.label()}
                        onChange={(_ev, v) => onChange(writeOption(options, opt, v === "" ? null : v))}>
                <FormSelectOption value="" label={cockpit.format(_("Default ($0)"), dflt)} />
                {opt.values.map(v => <FormSelectOption key={v.token} value={v.token} label={v.label()} />)}
            </FormSelect>
        );
    }

    if (opt.kind === "flag") {
        return (
            <Checkbox id={id} isChecked={value !== null} label={<code>{opt.id}</code>}
                      onChange={(_ev, c) => onChange(writeOption(options, opt, c ? "1" : null))} />
        );
    }

    if (opt.choices && opt.multiple) {
        const selected = (value ?? "").split(":").filter(Boolean);
        const set = (v: string, on: boolean) => {
            const next = opt.choices!.map(c => c.value).filter(c => (c === v ? on : selected.includes(c)));
            onChange(writeOption(options, opt, next.length ? next.join(":") : null));
        };
        return (
            <Flex spaceItems={{ default: "spaceItemsLg" }}>
                {opt.choices.map(c => (
                    <Checkbox key={c.value} id={`${id}-${c.value}`} label={c.label()}
                              isChecked={selected.includes(c.value)} onChange={(_ev, on) => set(c.value, on)} />))}
            </Flex>
        );
    }

    if (opt.choices) {
        return (
            <FormSelect id={id} value={value ?? ""} aria-label={opt.label()}
                        onChange={(_ev, v) => onChange(writeOption(options, opt, v === "" ? null : v))}>
                <FormSelectOption value="" label={_("Not set")} />
                {opt.choices.map(c => <FormSelectOption key={c.value} value={c.value} label={c.label()} />)}
            </FormSelect>
        );
    }

    if (opt.id === "mountpoint") {
        return (
            <Flex direction={{ default: "column" }} spaceItems={{ default: "spaceItemsSm" }}>
                <Checkbox id={id + "-on"} isChecked={value !== null} label={_("Export only when mounted")}
                          onChange={(_ev, on) => onChange(writeOption(options, opt, on ? "" : null))} />
                {value !== null &&
                    <TextInput id={id} value={value} placeholder={opt.placeholder ?? ""} aria-label={opt.label()}
                               onChange={(_ev, v) => onChange(writeOption(options, opt, v))} />}
            </Flex>
        );
    }

    const problem = value && opt.validate ? opt.validate(value) : null;
    return (
        <TextInput id={id} value={value ?? ""} placeholder={opt.placeholder ?? ""} aria-label={opt.label()}
                   validated={problem ? "error" : "default"}
                   onChange={(_ev, v) => onChange(writeOption(options, opt, v === "" ? null : v))} />
    );
};

export function optionProblems(options: string[]): string[] {
    const problems: string[] = [];
    for (const opt of EXPORT_OPTIONS) {
        if (opt.kind !== "value" || !opt.validate)
            continue;
        const v = readOption(options, opt);
        if (v) {
            const p = opt.validate(v);
            if (p)
                problems.push(`${opt.label()}: ${p}`);
        }
    }
    for (const o of otherOptions(options))
        if (!isKnownOption(o))
            problems.push(cockpit.format(_("Unknown option $0: exportfs will refuse it."), o));
    return problems;
}

function hostProblemText(host: string): string | null {
    switch (hostProblem(host)) {
    case null: return null;
    case "empty": return _("Enter a host, a network or *.");
    case "characters": return _("Blanks, parentheses, commas, quotes and # are not allowed.");
    case "dash": return _("A host cannot start with a dash.");
    default: return _("Invalid host.");
    }
}

export const HostInput = ({ id, value, onChange }: { id: string, value: string, onChange: (v: string) => void }) => {
    const nfs = useNfs();
    const [networks, setNetworks] = useState<string[]>([]);
    useEffect(() => {
        if (nfs.env)
            localNetworks(nfs.env).then(setNetworks);
    }, [nfs.env]);
    const options: TypeaheadSelectOption[] = [
        { value: "*", content: "*", description: _("Every host") },
        ...networks.map(n => ({ value: n, content: n, description: _("Local network") })),
    ];
    return (
        <TypeaheadSelect toggleProps={{ id }} selectOptions={options} isCreatable selected={value}
                         createOptionMessage={(v: string) => cockpit.format(_("Use \"$0\""), v)}
                         placeholder={_("Host name, address, network (10.0.0.0/8), *.domain or @netgroup")}
                         onSelect={(_ev, sel) => onChange(String(sel))}
                         onClearSelection={() => onChange("")} />
    );
};

const GROUPS: OptionGroup[] = ["access", "mapping", "security", "advanced"];

/**
 * Edit the client at `itemIndex` of an export entry, add a client (itemIndex
 * null) or edit a "-defaults" item (`defaults`).
 */
export const ClientDialog = ({ file, lineIndex, entry, itemIndex, defaults = false }: {
    file: string,
    lineIndex: number,
    entry: ExportEntry,
    itemIndex: number | null,
    defaults?: boolean,
}) => {
    const nfs = useNfs();
    const { error, busy, submit } = useSubmit();
    const existing = itemIndex === null ? null : entry.items[itemIndex];
    const [host, setHost] = useState(existing && existing.kind === "client" ? (existing.host || "*") : "");
    const [options, setOptions] = useState<string[]>(existing ? existing.options : ["rw", "sync", "no_subtree_check"]);
    const [other, setOther] = useState("");
    const isNew = itemIndex === null;

    // options of the "-defaults" items before this client apply when an option is not written
    const position = itemIndex ?? entry.items.length;
    const inheritedOptions = entry.items.slice(0, position).flatMap(i => (i.kind === "defaults" ? i.options : []));
    const inherited = (opt: ExportOption) => readOption(inheritedOptions, opt);

    const hostIssue = defaults ? null : hostProblemText(host);
    const problems = optionProblems(options);
    const extra = otherOptions(options);

    const onSubmit = () => submit(async () => {
        await nfs.updateExports(file, f => {
            const items = [...entry.items];
            const item: ClientItem | { kind: "defaults", options: string[] } = defaults
                ? { kind: "defaults", options }
                : { kind: "client", host: host.trim(), options };
            if (itemIndex === null)
                items.push(item);
            else
                items[itemIndex] = item;
            f.replace(lineIndex, { ...entry, items });
        });
    });

    const title = defaults
        ? _("Default options of the line")
        : (isNew ? _("Add a client") : cockpit.format(_("Client $0"), host === "*" ? _("Everyone") : host));

    return (
        <DialogFrame id="nfs-client-dialog" title={title} error={error} isSubmitting={busy} variant="large"
                     isDisabled={!!hostIssue || problems.length > 0} submitLabel={isNew ? _("Add") : _("Save")}
                     onSubmit={onSubmit}>
            <Form isHorizontal onSubmit={ev => { ev.preventDefault(); onSubmit() }}>
                {!defaults &&
                    <FormGroup label={_("Client")} fieldId="nfs-client-host" isRequired>
                        <HostInput id="nfs-client-host" value={host} onChange={setHost} />
                        <FormHelper fieldId="nfs-client-host" helperTextInvalid={host !== "" ? hostIssue ?? undefined : undefined}
                                    helperText={_("* lets every host connect.")} />
                    </FormGroup>}
                {GROUPS.map(group => (
                    <FormSection key={group} title={groupLabel(group)} titleElement="h3">
                        {EXPORT_OPTIONS.filter(o => o.group === group).map(opt => (
                            <FormGroup key={opt.id} label={opt.label()} fieldId={"nfs-opt-" + opt.id}
                                       labelHelp={<OptionHelp opt={opt} />}>
                                <OptionField opt={opt} options={options} inherited={inherited(opt)} onChange={setOptions} />
                            </FormGroup>))}
                    </FormSection>))}
                <FormSection title={_("Other options")} titleElement="h3">
                    <FormGroup label={_("Options")} fieldId="nfs-opt-other">
                        <Flex direction={{ default: "column" }} spaceItems={{ default: "spaceItemsSm" }}>
                            {extra.length > 0 &&
                                <LabelGroup numLabels={20}>
                                    {extra.map(o => (
                                        <Label key={o} color={isKnownOption(o) ? "grey" : "red"}
                                               onClose={() => setOptions(options.filter(x => x !== o))}
                                               closeBtnAriaLabel={cockpit.format(_("Remove $0"), o)}>
                                            {o}
                                        </Label>))}
                                </LabelGroup>}
                            <TextInput id="nfs-opt-other" value={other} placeholder={_("Option, then Enter")}
                                       onChange={(_ev, v) => setOther(v)}
                                       onKeyDown={ev => {
                                           if (ev.key === "Enter" && other.trim()) {
                                               ev.preventDefault();
                                               setOptions([...options, ...other.split(",").map(o => o.trim())
                                                       .filter(Boolean)]);
                                               setOther("");
                                           }
                                       }} />
                        </Flex>
                        <FormHelper fieldId="nfs-opt-other" helperTextInvalid={problems.length ? problems.join(" ") : undefined}
                                    helperText={_("Options not listed above, as written in /etc/exports.")} />
                    </FormGroup>
                </FormSection>
            </Form>
            <pre className="shares-preview" id="nfs-client-preview">
                {defaults ? "-" + options.join(",") : `${host || "…"}${options.length ? "(" + options.join(",") + ")" : ""}`}
            </pre>
        </DialogFrame>
    );
};
