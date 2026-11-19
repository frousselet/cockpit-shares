/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * SMB shares: list summaries for the overview, row actions and the dialogs
 * creating, renaming, duplicating and removing shares.
 */

import React, { useEffect, useMemo, useState } from "react";
import cockpit from "cockpit";

import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import { DropdownItem } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { Divider } from "@patternfly/react-core/dist/esm/components/Divider/index.js";
import { ExpandableSection } from "@patternfly/react-core/dist/esm/components/ExpandableSection/index.js";
import { Form, FormGroup, FormSection } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { Radio } from "@patternfly/react-core/dist/esm/components/Radio/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";

import { useDialogs, type Dialogs } from "dialogs";
import { KebabDropdown } from "cockpit-components-dropdown";
import { FormHelper } from "cockpit-components-form-helper";
import { FileAutoComplete } from "cockpit-components-file-autocomplete";

import { useSmb, type SmbState } from "../state.tsx";
import { parseBoolean, shareNameProblem, splitList, joinList, sameName, type SmbConf } from "../smbconf.ts";
import { createDirectory, statPath, getStatus } from "../backend.ts";
import type { PathInfo, SmbStatus } from "../parsers.ts";
import type { ShareSummary } from "../../types.ts";
import { DialogFrame, ConfirmDialog, TextPromptDialog, useSubmit, reportSave } from "./dialogs.tsx";
import { ParamField, ParamHelp } from "./param-field.tsx";
import { useAccounts } from "./accounts.ts";

const _ = cockpit.gettext;

export const SPECIAL_SECTIONS: Record<string, () => string> = {
    homes: () => _("Home directories"),
    printers: () => _("All printers"),
    print$: () => _("Printer drivers"),
};

export function specialLabel(name: string): string | null {
    const f = SPECIAL_SECTIONS[name.toLowerCase()];
    return f ? f() : null;
}

/** NetBIOS name clients use to reach this server. */
export function netbiosName(smb: SmbState): string {
    return smb.effective?.dump?.get("global", "netbios name") ?? smb.builtin("netbios name") ?? cockpit.transport.host;
}

export function shareLocation(name: string): string {
    return "/smb/share/" + encodeURIComponent(name);
}

export function shareProblemText(problem: string | null): string | null {
    switch (problem) {
    case null: return null;
    case "empty": return _("Enter a name.");
    case "spaces": return _("The name cannot start or end with a space.");
    case "brackets": return _("The name cannot contain [ or ].");
    case "control": return _("The name cannot contain control characters.");
    case "reserved": return _("The name cannot contain any of \" / \\ : | < > + = ; , * ?");
    case "length": return _("The name is limited to 80 characters.");
    case "global": return _("This name is reserved for the global settings.");
    default: return problem;
    }
}

function boolOf(value: string | undefined, fallback: string | undefined, dflt: boolean): boolean {
    const v = parseBoolean(value ?? fallback ?? "");
    return v === null ? dflt : v;
}

/** Number of tree connections per share name, refreshed while the page is visible. */
export function useSmbStatus(smb: SmbState, interval = 10000): { status: SmbStatus | null, error: unknown, refresh: () => void } {
    const [status, setStatus] = useState<SmbStatus | null>(null);
    const [error, setError] = useState<unknown>(null);
    const [generation, setGeneration] = useState(0);
    const env = smb.env;
    useEffect(() => {
        if (!env?.installed || !smb.admin)
            return;
        let cancelled = false;
        const poll = () => {
            if (document.visibilityState === "hidden")
                return;
            getStatus(env)
                    .then(s => { if (!cancelled) { setStatus(s); setError(null) } })
                    .catch(ex => { if (!cancelled) setError(ex); });
        };
        poll();
        const timer = window.setInterval(poll, interval);
        return () => { cancelled = true; window.clearInterval(timer) };
    }, [env, smb.admin, interval, generation]);
    return { status, error, refresh: () => setGeneration(g => g + 1) };
}

export function summarize(smb: SmbState, status: SmbStatus | null): ShareSummary[] {
    const conf = smb.config.conf;
    const result: ShareSummary[] = [];
    const counts = new Map<string, number>();
    for (const t of status?.tcons ?? [])
        counts.set(t.service.toLowerCase(), (counts.get(t.service.toLowerCase()) ?? 0) + 1);

    const add = (name: string, get: (n: string) => string | undefined, external: boolean) => {
        const inherited = (n: string) => smb.inherited(n);
        const special = specialLabel(name);
        const printable = boolOf(get("printable"), inherited("printable"), false);
        const labels: string[] = [];
        if (special)
            labels.push(special);
        if (!boolOf(get("browseable"), inherited("browseable"), true))
            labels.push(_("Hidden"));
        const vfs = splitList(get("vfs objects") ?? inherited("vfs objects") ?? "");
        if (vfs.includes("fruit") && boolOf(get("fruit:time machine"), inherited("fruit:time machine"), false))
            labels.push(_("Time Machine"));
        else if (vfs.includes("fruit"))
            labels.push(_("macOS"));
        if (vfs.includes("recycle"))
            labels.push(_("Recycle bin"));
        result.push({
            id: name,
            name,
            path: get("path") ?? (name.toLowerCase() === "homes" ? _("Each user's home directory") : ""),
            description: get("comment") ?? "",
            enabled: boolOf(get("available"), inherited("available"), true),
            access: printable ? "special" : (boolOf(get("read only"), inherited("read only"), true) ? "read-only" : "read-write"),
            guest: boolOf(get("guest ok"), inherited("guest ok"), false),
            labels,
            location: shareLocation(name),
            external,
            connections: status ? (counts.get(name.toLowerCase()) ?? 0) : null,
        });
    };

    for (const name of conf.sectionNames())
        add(name, n => conf.get(name, n), false);

    // shares that testparm sees but that are not in the file: included files, registry
    for (const name of smb.effective?.dump?.sectionNames() ?? []) {
        if (conf.hasSection(name))
            continue;
        const dump = smb.effective!.dump!;
        add(name, n => dump.get(name, n), true);
    }
    return result;
}

/** File shares (printers excluded) that do not load vfs_fruit. */
function otherSharesWithoutFruit(smb: SmbState): string[] {
    const conf = smb.config.conf;
    return conf.sectionNames().filter(name => {
        if (boolOf(conf.get(name, "printable"), smb.inherited("printable"), false))
            return false;
        return !splitList(conf.get(name, "vfs objects") ?? smb.inherited("vfs objects") ?? "").includes("fruit");
    });
}

/* === share recipes ================================================= */

export type Preset = "standard" | "public" | "macos" | "timemachine";

/** Parameters written by the creation dialog for each kind of share. */
export function presetParameters(preset: Preset, options: { readOnly: boolean, users: string[], timeMachineSize: string }): [string, string][] {
    const params: [string, string][] = [["read only", options.readOnly ? "yes" : "no"]];
    if (preset === "public") {
        params.push(["guest ok", "yes"]);
    } else if (options.users.length) {
        params.push(["valid users", joinList(options.users)]);
    }
    if (preset === "macos" || preset === "timemachine") {
        params.push(["vfs objects", "catia fruit streams_xattr"]);
        params.push(["fruit:metadata", "stream"]);
        params.push(["fruit:encoding", "native"]);
        params.push(["fruit:veto_appledouble", "no"]);
        params.push(["fruit:wipe_intentionally_left_blank_rfork", "yes"]);
        params.push(["fruit:delete_empty_adfiles", "yes"]);
    }
    if (preset === "timemachine") {
        params.push(["fruit:time machine", "yes"]);
        if (options.timeMachineSize.trim())
            params.push(["fruit:time machine max size", options.timeMachineSize.trim()]);
    }
    return params;
}

const PathStatus = ({ path, info }: { path: string, info: PathInfo | null }) => {
    if (!path || !info)
        return null;
    if (!info.exists)
        return <span>{_("This directory does not exist yet.")}</span>;
    if (!info.isDirectory)
        return <span>{_("This is not a directory.")}</span>;
    return <span>{cockpit.format(_("Owner $0, group $1, permissions $2"), info.owner, info.group, info.mode)}</span>;
};

export const CreateShareDialog = ({ initialPath = "" }: { initialPath?: string }) => {
    const smb = useSmb();
    const accounts = useAccounts();
    const [name, setName] = useState("");
    const [nameEdited, setNameEdited] = useState(false);
    const [path, setPath] = useState(initialPath);
    const [comment, setComment] = useState("");
    const [preset, setPreset] = useState<Preset>("standard");
    const [readOnly, setReadOnly] = useState(false);
    const [users, setUsers] = useState<string | undefined>(undefined);
    const [tmSize, setTmSize] = useState("");
    const [info, setInfo] = useState<PathInfo | null>(null);
    const [createDir, setCreateDir] = useState(true);
    const [owner, setOwner] = useState("root");
    const [group, setGroup] = useState("root");
    const [mode, setMode] = useState("2775");
    const { error, busy, submit } = useSubmit();

    useEffect(() => {
        if (!path || !smb.env) {
            setInfo(null);
            return;
        }
        let cancelled = false;
        const timer = window.setTimeout(() => {
            statPath(path, smb.env!).then(i => { if (!cancelled) setInfo(i); });
        }, 300);
        return () => { cancelled = true; window.clearTimeout(timer) };
    }, [path, smb.env]);

    // propose the last path component as name
    const suggested = path.replace(/\/+$/, "").split("/")
            .pop() ?? "";
    const effectiveName = nameEdited ? name : suggested;
    const exists = smb.config.conf.hasSection(effectiveName) || (smb.effective?.dump?.hasSection(effectiveName) ?? false);
    const nameProblem = effectiveName === "" && !nameEdited
        ? null
        : (exists && effectiveName ? _("A share with this name exists already.") : shareProblemText(shareNameProblem(effectiveName)));
    const pathProblem = path && !path.startsWith("/") ? _("Enter an absolute path.") : null;
    const needCreate = !!info && !info.exists;
    const modeProblem = needCreate && createDir && !/^[0-7]{3,4}$/.test(mode) ? _("Enter an octal mode, for example 2775.") : null;

    const onSubmit = () => submit(async () => {
        if (needCreate && createDir)
            await createDirectory(path, owner, group, mode);
        const result = await smb.update(conf => {
            conf.addSection(effectiveName);
            conf.set(effectiveName, "path", path);
            if (comment.trim())
                conf.set(effectiveName, "comment", comment.trim());
            for (const [k, v] of presetParameters(preset, { readOnly: readOnly && preset !== "timemachine", users: splitList(users ?? ""), timeMachineSize: tmSize }))
                conf.set(effectiveName, k, v, k.includes(":") ? k : undefined);
        });
        reportSave(smb, result);
        cockpit.location.go(shareLocation(effectiveName));
    });

    const canSubmit = effectiveName !== "" && path !== "" && !nameProblem && !pathProblem && !modeProblem;

    return (
        <DialogFrame id="smb-create-share" title={_("Create SMB share")} error={error} isSubmitting={busy}
                     isDisabled={!canSubmit} submitLabel={_("Create")} onSubmit={onSubmit}
        >
            <Form isHorizontal onSubmit={ev => { ev.preventDefault(); if (canSubmit) onSubmit(); }}>
                <FormGroup label={_("Directory")} fieldId="smb-create-path" isRequired>
                    <FileAutoComplete id="smb-create-path" value={path} onlyDirectories isOptionCreatable superuser="try"
                                      placeholder={_("/srv/share")}
                                      onChange={(v: string) => setPath(v)}
                    />
                    <FormHelper fieldId="smb-create-path" helperTextInvalid={pathProblem ?? undefined}
                                helperText={<PathStatus path={path} info={info} />}
                    />
                </FormGroup>
                {needCreate &&
                    <FormGroup fieldId="smb-create-mkdir" label={_("New directory")} isStack>
                        <Checkbox id="smb-create-mkdir" isChecked={createDir} onChange={(_ev, c) => setCreateDir(c)}
                                  label={_("Create the directory")}
                        />
                        {createDir &&
                            <Flex spaceItems={{ default: "spaceItemsSm" }}>
                                <TextInput id="smb-create-owner" aria-label={_("Owner")} value={owner} onChange={(_ev, v) => setOwner(v)} className="shares-short-input" />
                                <TextInput id="smb-create-group" aria-label={_("Group")} value={group} onChange={(_ev, v) => setGroup(v)} className="shares-short-input" />
                                <TextInput id="smb-create-mode" aria-label={_("Permissions")} value={mode} onChange={(_ev, v) => setMode(v)}
                                           className="shares-short-input" validated={modeProblem ? "error" : "default"}
                                />
                            </Flex>}
                        <FormHelper fieldId="smb-create-mode" helperTextInvalid={modeProblem ?? undefined}
                                    helperText={createDir ? _("Owner, group and permissions of the new directory.") : undefined}
                        />
                    </FormGroup>}
                <FormGroup label={_("Share name")} fieldId="smb-create-name" isRequired>
                    <TextInput id="smb-create-name" value={effectiveName}
                               validated={nameProblem ? "error" : "default"}
                               onChange={(_ev, v) => { setName(v); setNameEdited(true) }}
                    />
                    <FormHelper fieldId="smb-create-name" helperTextInvalid={nameProblem ?? undefined}
                                helperText={effectiveName ? cockpit.format(_("Clients connect to $0"), `\\\\${netbiosName(smb)}\\${effectiveName}`) : undefined}
                    />
                </FormGroup>
                <FormGroup label={_("Description")} fieldId="smb-create-comment">
                    <TextInput id="smb-create-comment" value={comment} onChange={(_ev, v) => setComment(v)} />
                </FormGroup>
                <FormGroup label={_("Kind")} fieldId="smb-create-preset" role="radiogroup" isStack>
                    <Radio id="smb-preset-standard" name="preset" isChecked={preset === "standard"} onChange={() => setPreset("standard")}
                           label={_("Standard")} description={_("Users sign in with their Samba account.")}
                    />
                    <Radio id="smb-preset-public" name="preset" isChecked={preset === "public"} onChange={() => setPreset("public")}
                           label={_("Public")} description={_("Anyone on the network can connect without a password.")}
                    />
                    <Radio id="smb-preset-macos" name="preset" isChecked={preset === "macos"} onChange={() => setPreset("macos")}
                           label={_("Optimized for macOS")} description={_("Adds the catia, fruit and streams_xattr modules for Finder metadata.")}
                    />
                    <Radio id="smb-preset-timemachine" name="preset" isChecked={preset === "timemachine"} onChange={() => setPreset("timemachine")}
                           label={_("Time Machine backups")} description={_("macOS computers can back up to this share.")}
                    />
                </FormGroup>
                {(preset === "macos" || preset === "timemachine") && otherSharesWithoutFruit(smb).length > 0 &&
                    <Alert variant="info" isInline isPlain id="smb-create-fruit-note"
                           title={_("Samba recommends the fruit module on every share used by Macs")}>
                        {cockpit.format(_("Without it on $0, testparm reports a warning. Adding catia fruit streams_xattr to vfs objects in the global settings applies it everywhere."),
                                        otherSharesWithoutFruit(smb).join(", "))}
                    </Alert>}
                <FormSection>
                    <FormGroup fieldId="smb-create-readonly" label={_("Access")}>
                        <Checkbox id="smb-create-readonly" isChecked={readOnly} isDisabled={preset === "timemachine"}
                                  onChange={(_ev, c) => setReadOnly(c)} label={_("Read only")}
                        />
                    </FormGroup>
                    {preset !== "public" &&
                        <FormGroup label={_("Allowed users and groups")} fieldId="smb-create-users"
                                   labelHelp={<ParamHelp name="valid users" />}
                        >
                            <ParamField id="smb-create-users" name="valid users" kind="principals" value={users}
                                        accounts={accounts} onChange={setUsers}
                            />
                            <FormHelper fieldId="smb-create-users" helperText={_("Empty: every Samba user.")} />
                        </FormGroup>}
                    {preset === "timemachine" &&
                        <FormGroup label={_("Maximum backup size")} fieldId="smb-create-tmsize"
                                   labelHelp={<ParamHelp name="fruit:time machine max size" />}
                        >
                            <TextInput id="smb-create-tmsize" value={tmSize} placeholder={_("unlimited")}
                                       onChange={(_ev, v) => setTmSize(v)}
                            />
                            <FormHelper fieldId="smb-create-tmsize" helperText={_("For example 500G or 2T.")} />
                        </FormGroup>}
                </FormSection>
            </Form>
            <Divider className="shares-dialog-divider" />
            <ExpandableSection toggleText={_("Lines added to smb.conf")} id="smb-create-preview">
                <pre className="shares-preview">
                    {[`[${effectiveName || "…"}]`, `\tpath = ${path}`,
                        ...(comment.trim() ? [`\tcomment = ${comment.trim()}`] : []),
                        ...presetParameters(preset, { readOnly: readOnly && preset !== "timemachine", users: splitList(users ?? ""), timeMachineSize: tmSize }).map(([k, v]) => `\t${k} = ${v}`)].join("\n")}
                </pre>
            </ExpandableSection>
        </DialogFrame>
    );
};

function copySection(conf: SmbConf, from: string, to: string) {
    const view = conf.section(from);
    conf.addSection(to);
    for (const p of view?.parameters.values() ?? [])
        conf.set(to, p.name, p.value, p.name.includes(":") ? p.key : undefined);
}

export function renameShare(Dialogs: Dialogs, smb: SmbState, name: string) {
    Dialogs.show(
        <TextPromptDialog id="smb-rename-share" title={cockpit.format(_("Rename $0"), name)} label={_("New name")}
                          initial={name} submitLabel={_("Rename")}
                          help={_("Clients that mapped the share need to connect to the new name.")}
                          validate={v => {
                              if (v === name)
                                  return _("Enter a different name.");
                              if (!sameName(v, name) && smb.config.conf.hasSection(v))
                                  return _("A share with this name exists already.");
                              return shareProblemText(shareNameProblem(v));
                          }}
                          onSubmit={async v => {
                              const result = await smb.update(conf => conf.renameSection(name, v));
                              reportSave(smb, result);
                              cockpit.location.go(shareLocation(v));
                          }}
        />);
}

export function duplicateShare(Dialogs: Dialogs, smb: SmbState, name: string) {
    Dialogs.show(
        <TextPromptDialog id="smb-duplicate-share" title={cockpit.format(_("Duplicate $0"), name)} label={_("Name of the copy")}
                          initial={name + "-copy"} submitLabel={_("Duplicate")}
                          help={_("The copy uses the same directory and settings, change them afterwards.")}
                          validate={v => smb.config.conf.hasSection(v) ? _("A share with this name exists already.") : shareProblemText(shareNameProblem(v))}
                          onSubmit={async v => {
                              const result = await smb.update(conf => copySection(conf, name, v));
                              reportSave(smb, result);
                              cockpit.location.go(shareLocation(v));
                          }}
        />);
}

export function deleteShare(Dialogs: Dialogs, smb: SmbState, name: string, goBack: boolean) {
    Dialogs.show(
        <ConfirmDialog id="smb-delete-share" title={cockpit.format(_("Delete share $0?"), name)}
                       body={_("The share is removed from smb.conf and clients are disconnected. The directory and its files are kept.")}
                       confirmLabel={_("Delete")}
                       onConfirm={async () => {
                           const result = await smb.update(conf => conf.removeSection(name));
                           reportSave(smb, result);
                           if (goBack)
                               cockpit.location.go("/");
                       }}
        />);
}

export async function setShareEnabled(smb: SmbState, name: string, enabled: boolean) {
    const result = await smb.update(conf => {
        // "available = yes" is the default: remove the line instead of writing it
        if (enabled)
            conf.unset(name, "available");
        else
            conf.set(name, "available", "no");
    });
    reportSave(smb, result);
}

export const ShareActions = ({ name, external, onDetails = true }: { name: string, external: boolean, onDetails?: boolean }) => {
    const smb = useSmb();
    const Dialogs = useDialogs();
    const enabled = useMemo(() => boolOf(smb.config.conf.get(name, "available"), smb.inherited("available"), true), [smb, name]);
    if (!smb.admin || external)
        return null;
    const items = [];
    if (onDetails)
        items.push(<DropdownItem key="details" onClick={() => cockpit.location.go(shareLocation(name))}>{_("Edit")}</DropdownItem>);
    items.push(
        <DropdownItem key="toggle" onClick={() => setShareEnabled(smb, name, !enabled).catch(ex => smb.notify({ variant: "danger", title: String(ex.message), detail: ex.diagnostics?.map((d: { message: string }) => d.message) }))}>
            {enabled ? _("Disable") : _("Enable")}
        </DropdownItem>,
        <DropdownItem key="rename" onClick={() => renameShare(Dialogs, smb, name)}>{_("Rename")}</DropdownItem>,
        <DropdownItem key="duplicate" onClick={() => duplicateShare(Dialogs, smb, name)}>{_("Duplicate")}</DropdownItem>,
        <Divider key="sep" component="li" />,
        <DropdownItem key="delete" className="pf-m-danger" onClick={() => deleteShare(Dialogs, smb, name, !onDetails)}>{_("Delete")}</DropdownItem>,
    );
    return <KebabDropdown toggleButtonId={"share-actions-" + name.replace(/\W+/g, "-")} dropdownItems={items} />;
};
