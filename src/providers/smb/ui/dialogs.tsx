/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Dialogs editing smb.conf parameters.
 */

import React, { useMemo, useState } from "react";
import cockpit from "cockpit";

import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { Content } from "@patternfly/react-core/dist/esm/components/Content/index.js";

import { useDialogs } from "dialogs";
import { FormHelper } from "cockpit-components-form-helper";
import { TypeaheadSelect, type TypeaheadSelectOption } from "cockpit-components-typeahead-select";

import { useSmb, type SmbState } from "../state.tsx";
import { isGlobalSection, normalizeKey } from "../smbconf.ts";
import {
    PARAMETERS, VFS_MODULES, getParam, catalogResolver, isParametric, normalizeParametric, parametricTemplate,
} from "../catalog.ts";
import type { SaveResult } from "../backend.ts";
import { ErrorAlert } from "../../../lib/utils.tsx";
import { SambaDoc } from "../../../lib/doc.tsx";
import { ParamField, ParamHelp, validateParam, definitionOf, displayValue } from "./param-field.tsx";
import { RESTART_PARAMETERS, type FieldGroup } from "./labels.ts";
import { useAccounts } from "./accounts.ts";

const _ = cockpit.gettext;

/** Report what happened after a save: testparm warnings, restart needed. */
export function reportSave(smb: SmbState, result: SaveResult, changedGlobals: string[] = []) {
    // only report what this change introduced; known problems are shown on the overview
    const known = new Set((smb.effective?.diagnostics ?? []).map(d => d.message));
    const warnings = result.diagnostics.filter(d => d.level !== "info" && !known.has(d.message));
    if (warnings.length)
        smb.notify({ variant: "warning", title: _("Saved with warnings from testparm"), detail: warnings.map(d => d.message) });
    const restart = changedGlobals.filter(n => RESTART_PARAMETERS.has(catalogResolver(n).name));
    if (restart.length)
        smb.notify({
            variant: "info",
            title: _("Restart the file server to apply all changes"),
            detail: [cockpit.format(_("These settings are only read at startup: $0"), restart.join(", "))],
            restart: true,
        });
}

/** Current explicit value of a parameter in a section. */
export function sectionValue(smb: SmbState, section: string, name: string): string | undefined {
    return smb.config.conf.get(section, name);
}

/** What applies when a parameter is not set in this section. */
export function fallbackValue(smb: SmbState, section: string, name: string): string | undefined {
    return isGlobalSection(section) ? smb.builtin(name) : smb.inherited(name);
}

const DialogFrame = ({ id, title, help, error, children, onSubmit, submitLabel, isSubmitting, isDisabled = false, variant = "medium", isDanger = false }: {
    id: string,
    title: string,
    help?: React.ReactNode,
    error: unknown,
    children: React.ReactNode,
    onSubmit: () => void,
    submitLabel?: string,
    isSubmitting: boolean,
    isDisabled?: boolean,
    variant?: "small" | "medium" | "large",
    isDanger?: boolean,
}) => {
    const Dialogs = useDialogs();
    return (
        <Modal id={id} position="top" variant={variant} isOpen onClose={Dialogs.close}
               aria-labelledby={id + "-title"}
        >
            <ModalHeader title={title} labelId={id + "-title"} help={help} {...(isDanger ? { titleIconVariant: "warning" as const } : {})} />
            <ModalBody>
                {!!error && <ErrorAlert error={error} />}
                {children}
            </ModalBody>
            <ModalFooter>
                <Button variant={isDanger ? "danger" : "primary"} id={id + "-submit"} onClick={onSubmit}
                        isLoading={isSubmitting} isDisabled={isSubmitting || isDisabled}
                >
                    {submitLabel ?? _("Save")}
                </Button>
                <Button variant="link" id={id + "-cancel"} onClick={Dialogs.close} isDisabled={isSubmitting}>
                    {_("Cancel")}
                </Button>
            </ModalFooter>
        </Modal>
    );
};

export { DialogFrame };

/** Run an async action from a dialog: busy state, errors, close on success. */
export function useSubmit() {
    const Dialogs = useDialogs();
    const [error, setError] = useState<unknown>(null);
    const [busy, setBusy] = useState(false);
    const submit = async (action: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            await action();
            Dialogs.close();
        } catch (ex) {
            setError(ex);
            setBusy(false);
        }
    };
    return { error, busy, submit, setError };
}

/** Form for a group of curated parameters. Only fields the user touched are written. */
export const FieldGroupDialog = ({ section, group, title }: { section: string, group: FieldGroup, title?: string }) => {
    const smb = useSmb();
    const accounts = useAccounts();
    const original = useMemo(() => Object.fromEntries(group.fields.map(f => [f.name, sectionValue(smb, section, f.name)])),
        // eslint-disable-next-line react-hooks/exhaustive-deps
                             []);
    const [values, setValues] = useState<Record<string, string | undefined>>(original);
    const { error, busy, submit } = useSubmit();
    const changed = group.fields.map(f => f.name).filter(n => values[n] !== original[n]);
    const problems = Object.fromEntries(group.fields.map(f => [f.name, validateParam(f.name, values[f.name])]));
    const hasProblems = Object.values(problems).some(Boolean);

    const onSubmit = () => submit(async () => {
        if (changed.length === 0)
            return;
        const result = await smb.update(conf => {
            for (const name of changed) {
                const v = values[name];
                if (v === undefined)
                    conf.unset(section, name);
                else
                    conf.set(section, name, v.trim());
            }
        });
        reportSave(smb, result, isGlobalSection(section) ? changed : []);
    });

    return (
        <DialogFrame id={"smb-edit-" + group.id} error={error} isSubmitting={busy} isDisabled={hasProblems}
                     title={title ?? group.title()} onSubmit={onSubmit} variant="medium"
        >
            <Form isHorizontal onSubmit={ev => { ev.preventDefault(); onSubmit() }}>
                {group.fields.map(f => {
                    const def = definitionOf(f.name);
                    if (!def)
                        return null;
                    if (!isGlobalSection(section) && "context" in def && def.context === "G")
                        return null;
                    const id = `smb-field-${group.id}-${f.name.replace(/\W+/g, "-")}`;
                    return (
                        <FormGroup key={f.name} label={f.label()} fieldId={id}
                                   labelHelp={<ParamHelp name={f.name} />}
                        >
                            <ParamField id={id} name={f.name} value={values[f.name]} kind={f.kind}
                                        fallback={fallbackValue(smb, section, f.name)} accounts={accounts}
                                        onChange={v => setValues(old => ({ ...old, [f.name]: v }))}
                            />
                            <FormHelper fieldId={id}
                                        helperText={f.help?.() ?? <code className="shares-param-name">{f.name}</code>}
                                        helperTextInvalid={problems[f.name] ?? undefined}
                            />
                        </FormGroup>
                    );
                })}
            </Form>
        </DialogFrame>
    );
};

/** Edit one parameter of a section, with its full documentation. */
export const ParamEditDialog = ({ section, name }: { section: string, name: string }) => {
    const smb = useSmb();
    const accounts = useAccounts();
    const original = sectionValue(smb, section, name);
    const [value, setValue] = useState<string | undefined>(original);
    const { error, busy, submit } = useSubmit();
    const problem = validateParam(name, value);
    const def = definitionOf(name);
    const id = "smb-param-edit";

    const onSubmit = () => submit(async () => {
        if (value === original)
            return;
        const result = await smb.update(conf => {
            if (value === undefined)
                conf.unset(section, name);
            else
                conf.set(section, name, value.trim(), isParametric(name) ? name : undefined);
        });
        reportSave(smb, result, isGlobalSection(section) ? [name] : []);
    });

    const fallback = fallbackValue(smb, section, name);
    return (
        <DialogFrame id={id} error={error} isSubmitting={busy} isDisabled={!!problem}
                     title={cockpit.format(_("Edit $0"), name)} onSubmit={onSubmit} variant="large"
        >
            <Form onSubmit={ev => { ev.preventDefault(); onSubmit() }}>
                <FormGroup label={_("Value")} fieldId={id + "-value"}>
                    <ParamField id={id + "-value"} name={name} value={value} fallback={fallback} accounts={accounts}
                                onChange={setValue}
                    />
                    <FormHelper fieldId={id + "-value"} helperTextInvalid={problem ?? undefined}
                                helperText={fallback !== undefined && fallback !== ""
                                    ? cockpit.format(isGlobalSection(section) ? _("Built-in default: $0") : _("Inherited value: $0"), displayValue(name, fallback))
                                    : undefined}
                    />
                </FormGroup>
            </Form>
            <div className="shares-doc-panel">
                <SambaDoc html={def?.doc ?? ""} />
            </div>
        </DialogFrame>
    );
};

/** Add any parameter, including module options such as "fruit:time machine". */
export const AddParamDialog = ({ section, exclude }: { section: string, exclude: Set<string> }) => {
    const smb = useSmb();
    const accounts = useAccounts();
    const [name, setName] = useState("");
    const [value, setValue] = useState<string | undefined>(undefined);
    const { error, busy, submit } = useSubmit();
    const global = isGlobalSection(section);

    const options = useMemo(() => {
        const list: TypeaheadSelectOption[] = [{ decorator: "header", content: _("Parameters"), key: "h-p" }];
        for (const p of PARAMETERS) {
            if (exclude.has(p.name) || (!global && p.context === "G"))
                continue;
            list.push({ value: p.name, content: p.name, description: p.deprecated ? _("Deprecated") : undefined });
        }
        list.push({ decorator: "divider", key: "d" });
        list.push({ decorator: "header", content: _("VFS module options"), key: "h-v" });
        for (const m of VFS_MODULES)
            for (const o of m.options)
                if (!exclude.has(o.name.toLowerCase()))
                    list.push({ value: o.name, content: o.name, description: m.summary });
        return list;
    }, [exclude, global]);

    const key = name.trim();
    const canonical = key === "" ? "" : (isParametric(key) ? normalizeParametric(key) : catalogResolver(key).name);
    const def = key ? definitionOf(key) ?? parametricTemplate(key) : undefined;
    const known = !!getParam(key) || isParametric(key);
    const nameProblem = key === ""
        ? null
        : !known
            ? _("Samba does not know this parameter. Module options are written as module:option.")
            : exclude.has(canonical)
                ? _("This parameter is already set, edit it in the list.")
                : (!global && getParam(key)?.context === "G" ? _("This parameter is only valid in the global settings.") : null);
    const problem = validateParam(key, value);

    const onSubmit = () => submit(async () => {
        const result = await smb.update(conf => conf.set(section, canonical, (value ?? "").trim(), isParametric(key) ? normalizeKey(key) : undefined));
        reportSave(smb, result, global ? [canonical] : []);
    });

    return (
        <DialogFrame id="smb-param-add" error={error} isSubmitting={busy}
                     isDisabled={key === "" || !!nameProblem || !!problem}
                     title={_("Add a parameter")} onSubmit={onSubmit} submitLabel={_("Add")} variant="large"
        >
            <Form isHorizontal onSubmit={ev => { ev.preventDefault(); onSubmit() }}>
                <FormGroup label={_("Parameter")} fieldId="smb-param-add-name" isRequired>
                    <TypeaheadSelect toggleProps={{ id: "smb-param-add-name" }} selectOptions={options} isCreatable
                                     createOptionMessage={(v: string) => cockpit.format(_("Use \"$0\""), v)}
                                     placeholder={_("Search a parameter or type module:option")}
                                     noOptionsFoundMessage={_("No matching parameter")}
                                     selected={name}
                                     onSelect={(_ev, sel) => { setName(String(sel)); setValue(undefined) }}
                                     onClearSelection={() => setName("")}
                    />
                    <FormHelper fieldId="smb-param-add-name" helperTextInvalid={nameProblem ?? undefined} />
                </FormGroup>
                {key !== "" && !nameProblem &&
                    <FormGroup label={_("Value")} fieldId="smb-param-add-value">
                        <ParamField key={canonical} id="smb-param-add-value" name={key} value={value} accounts={accounts}
                                    fallback={fallbackValue(smb, section, key)} onChange={setValue}
                                    unsetLabel={_("Choose a value")}
                        />
                        <FormHelper fieldId="smb-param-add-value" helperTextInvalid={problem ?? undefined}
                                    helperText={def && "hint" in def && def.hint ? cockpit.format(_("Expected: $0"), def.hint) : undefined}
                        />
                    </FormGroup>}
            </Form>
            {def &&
                <div className="shares-doc-panel">
                    <SambaDoc html={def.doc} />
                </div>}
        </DialogFrame>
    );
};

export const ConfirmDialog = ({ id, title, body, confirmLabel, onConfirm, isDanger = true }: {
    id: string,
    title: string,
    body: React.ReactNode,
    confirmLabel: string,
    onConfirm: () => Promise<void>,
    isDanger?: boolean,
}) => {
    const { error, busy, submit } = useSubmit();
    return (
        <DialogFrame id={id} title={title} error={error} isSubmitting={busy} variant="small" isDanger={isDanger}
                     submitLabel={confirmLabel} onSubmit={() => submit(onConfirm)}
        >
            <Content component="p">{body}</Content>
        </DialogFrame>
    );
};

export const TextPromptDialog = ({ id, title, label, initial, validate, submitLabel, onSubmit, help }: {
    id: string,
    title: string,
    label: string,
    initial: string,
    validate: (v: string) => string | null,
    submitLabel: string,
    onSubmit: (v: string) => Promise<void>,
    help?: string,
}) => {
    const [value, setValue] = useState(initial);
    const { error, busy, submit } = useSubmit();
    const problem = validate(value);
    return (
        <DialogFrame id={id} title={title} error={error} isSubmitting={busy} variant="small"
                     isDisabled={!!problem} submitLabel={submitLabel} onSubmit={() => submit(() => onSubmit(value))}
        >
            <Form onSubmit={ev => { ev.preventDefault(); if (!problem) submit(() => onSubmit(value)); }}>
                <FormGroup label={label} fieldId={id + "-input"} isRequired>
                    <TextInput id={id + "-input"} value={value} onChange={(_ev, v) => setValue(v)}
                               validated={problem && value !== initial ? "error" : "default"}
                    />
                    <FormHelper fieldId={id + "-input"} helperText={help}
                                helperTextInvalid={value !== initial ? problem ?? undefined : undefined}
                    />
                </FormGroup>
            </Form>
        </DialogFrame>
    );
};
