/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * NFS server settings (nfs.conf, written with nfsconf).
 */

import React, { useState } from "react";
import cockpit from "cockpit";

import { Breadcrumb, BreadcrumbItem } from "@patternfly/react-core/dist/esm/components/Breadcrumb/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { DropdownItem } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { Page, PageBreadcrumb, PageSection } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import { useDialogs } from "dialogs";
import { ListingTable } from "cockpit-components-table";
import { KebabDropdown } from "cockpit-components-dropdown";
import { EmptyStatePanel } from "cockpit-components-empty-state";
import { FormHelper } from "cockpit-components-form-helper";

import { useNfs } from "../state.tsx";
import { NFS_CONF } from "../backend.ts";
import { DialogFrame, ConfirmDialog, useSubmit } from "../../smb/ui/dialogs.tsx";
import { SectionTabs } from "../../smb/ui/tabs.tsx";
import { CONF_SETTINGS, confSetting, confBoolean, type ConfSetting } from "./options.ts";
import { NfsNotices } from "./common.tsx";

const _ = cockpit.gettext;

interface ConfGroup {
    id: string;
    title: () => string;
    description: () => string;
    settings: [string, string][];
}

const SERVER: ConfGroup = {
    id: "server",
    title: () => _("Server"),
    description: () => _("Protocol versions, transports and capacity of the kernel NFS server."),
    settings: [
        ["nfsd", "vers3"], ["nfsd", "vers4"], ["nfsd", "vers4.0"], ["nfsd", "vers4.1"], ["nfsd", "vers4.2"],
        ["nfsd", "tcp"], ["nfsd", "udp"], ["nfsd", "threads"], ["nfsd", "host"],
        ["nfsd", "grace-time"], ["nfsd", "lease-time"], ["mountd", "manage-gids"], ["exports", "rootdir"],
    ],
};

const PORTS: ConfGroup = {
    id: "ports",
    title: () => _("Firewall ports"),
    description: () => _("NFSv4 only needs port 2049. NFSv3 also uses mountd, statd and lockd, on random ports unless they are fixed here."),
    settings: [
        ["nfsd", "port"], ["mountd", "port"], ["statd", "port"], ["statd", "outgoing-port"], ["lockd", "port"], ["lockd", "udp-port"],
    ],
};

function displayConf(setting: ConfSetting | undefined, value: string): string {
    if (setting?.type === "boolean") {
        const b = confBoolean(value);
        return b === null ? value : (b ? _("Yes") : _("No"));
    }
    return value;
}

function validateConf(setting: ConfSetting | undefined, value: string): string | null {
    if (/[\r\n]/.test(value))
        return _("Line breaks are not allowed.");
    if (setting?.type === "integer" && value !== "" && !/^\d+$/.test(value))
        return _("Enter a whole number.");
    if (setting?.type === "boolean" && value !== "" && confBoolean(value) === null)
        return _("Use yes or no.");
    return null;
}

const ConfField = ({ id, setting, value, onChange }: { id: string, setting: ConfSetting | undefined, value: string | null, onChange: (v: string | null) => void }) => {
    if (setting?.type === "boolean") {
        const b = value === null ? "" : (confBoolean(value) === null ? value : (confBoolean(value) ? "y" : "n"));
        return (
            <FormSelect id={id} value={b} aria-label={setting.label()} onChange={(_ev, v) => onChange(v === "" ? null : v)}>
                <FormSelectOption value="" label={cockpit.format(_("Default ($0)"), displayConf(setting, setting.default))} />
                <FormSelectOption value="y" label={_("Yes")} />
                <FormSelectOption value="n" label={_("No")} />
            </FormSelect>
        );
    }
    return (
        <TextInput id={id} value={value ?? ""} placeholder={setting?.default ?? ""} aria-label={setting?.label() ?? id}
                   validated={validateConf(setting, value ?? "") ? "error" : "default"}
                   onChange={(_ev, v) => onChange(v === "" ? null : v)} />
    );
};

const ConfGroupDialog = ({ group }: { group: ConfGroup }) => {
    const nfs = useNfs();
    const { error, busy, submit } = useSubmit();
    const current = (s: string, k: string) => nfs.conf.get(s)?.get(k) ?? null;
    const [values, setValues] = useState<Record<string, string | null>>(
        Object.fromEntries(group.settings.map(([s, k]) => [`${s}.${k}`, current(s, k)])));
    const problems = group.settings.map(([s, k]) => validateConf(confSetting(s, k), values[`${s}.${k}`] ?? "")).filter(Boolean);

    const onSubmit = () => submit(async () => {
        const changes = group.settings
                .filter(([s, k]) => values[`${s}.${k}`] !== current(s, k))
                .map(([section, key]) => ({ section, key, value: values[`${section}.${key}`] }));
        await nfs.saveConf(changes);
    });

    return (
        <DialogFrame id={"nfs-conf-" + group.id} title={group.title()} error={error} isSubmitting={busy}
                     isDisabled={problems.length > 0} onSubmit={onSubmit}>
            <Form isHorizontal onSubmit={ev => { ev.preventDefault(); onSubmit() }}>
                {group.settings.map(([s, k]) => {
                    const setting = confSetting(s, k);
                    const id = `nfs-conf-${s}-${k}`.replace(/\W+/g, "-");
                    const v = values[`${s}.${k}`];
                    return (
                        <FormGroup key={`${s}.${k}`} label={setting?.label() ?? k} fieldId={id}>
                            <ConfField id={id} setting={setting} value={v} onChange={nv => setValues(old => ({ ...old, [`${s}.${k}`]: nv }))} />
                            <FormHelper fieldId={id} helperTextInvalid={validateConf(setting, v ?? "") ?? undefined}
                                        helperText={<>{setting?.help?.()} <code className="shares-param-name">[{s}] {k}</code></>} />
                        </FormGroup>
                    );
                })}
            </Form>
        </DialogFrame>
    );
};

const ConfGroupCard = ({ group }: { group: ConfGroup }) => {
    const nfs = useNfs();
    const Dialogs = useDialogs();
    return (
        <Card isPlain className="ct-card shares-group" id={"nfs-conf-card-" + group.id}>
            <CardHeader actions={{
                actions: nfs.admin && nfs.env?.tools.nfsconf
                    ? <Button variant="secondary" id={"nfs-conf-" + group.id + "-edit"} onClick={() => Dialogs.show(<ConfGroupDialog group={group} />)}>{_("Edit")}</Button>
                    : null,
            }}>
                <CardTitle component="h2" className="shares-group-description">{group.description()}</CardTitle>
            </CardHeader>
            <CardBody>
                <DescriptionList isHorizontal isCompact className="shares-settings" horizontalTermWidthModifier={{ default: "14rem", lg: "20rem" }}>
                    {group.settings.map(([s, k]) => {
                        const setting = confSetting(s, k);
                        const v = nfs.conf.get(s)?.get(k);
                        return (
                            <DescriptionListGroup key={`${s}.${k}`}>
                                <DescriptionListTerm>{setting?.label() ?? k}</DescriptionListTerm>
                                <DescriptionListDescription data-setting={`${s}.${k}`}>
                                    {v !== undefined
                                        ? <span className="shares-param-value">{displayConf(setting, v) || <em>{_("empty")}</em>}</span>
                                        : <span className="shares-param-fallback">
                                            {setting?.default ? displayConf(setting, setting.default) : _("not set")}
                                            {setting?.default ? <span className="shares-param-origin">{_("default")}</span> : null}
                                        </span>}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        );
                    })}
                </DescriptionList>
            </CardBody>
        </Card>
    );
};

const OneSettingDialog = ({ section, keyName, isNew = false }: { section: string, keyName: string, isNew?: boolean }) => {
    const nfs = useNfs();
    const { error, busy, submit } = useSubmit();
    const [s, setS] = useState(section);
    const [k, setK] = useState(keyName);
    const setting = confSetting(s, k);
    const [value, setValue] = useState<string | null>(nfs.conf.get(section)?.get(keyName) ?? null);
    const nameProblem = !/^[\w.-]+$/.test(s) || !/^[\w.-]+$/.test(k) ? _("Use letters, digits, dots, dashes and underscores.") : null;
    const problem = validateConf(setting, value ?? "");
    return (
        <DialogFrame id="nfs-conf-one" title={isNew ? _("Add a setting") : cockpit.format(_("Edit $0"), `[${section}] ${keyName}`)}
                     error={error} isSubmitting={busy} isDisabled={!!problem || (isNew && (!!nameProblem || value === null))}
                     submitLabel={isNew ? _("Add") : _("Save")}
                     onSubmit={() => submit(() => nfs.saveConf([{ section: s, key: k, value }]))}>
            <Form isHorizontal onSubmit={ev => ev.preventDefault()}>
                {isNew &&
                    <>
                        <FormGroup label={_("Section")} fieldId="nfs-conf-one-section" isRequired>
                            <TextInput id="nfs-conf-one-section" value={s} onChange={(_ev, v) => setS(v.trim())} />
                        </FormGroup>
                        <FormGroup label={_("Setting")} fieldId="nfs-conf-one-key" isRequired>
                            <TextInput id="nfs-conf-one-key" value={k} onChange={(_ev, v) => setK(v.trim())} />
                            <FormHelper fieldId="nfs-conf-one-key" helperTextInvalid={s && k ? nameProblem ?? undefined : undefined}
                                        helperText={_("Section and name as documented in nfs.conf(5).")} />
                        </FormGroup>
                    </>}
                <FormGroup label={_("Value")} fieldId="nfs-conf-one-value">
                    <ConfField id="nfs-conf-one-value" setting={setting} value={value} onChange={setValue} />
                    <FormHelper fieldId="nfs-conf-one-value" helperTextInvalid={problem ?? undefined}
                                helperText={setting?.help?.() ?? (setting ? undefined : _("This setting is not described here; the value is written as entered."))} />
                </FormGroup>
            </Form>
        </DialogFrame>
    );
};

const AllSettings = () => {
    const nfs = useNfs();
    const Dialogs = useDialogs();
    const [mode, setMode] = useState<"set" | "all">("set");
    const known = new Set(CONF_SETTINGS.map(c => `${c.section}.${c.key}`));
    const rows: { section: string, key: string, setting: ConfSetting | undefined }[] = [];
    for (const [section, keys] of nfs.conf)
        for (const key of keys.keys())
            rows.push({ section, key, setting: confSetting(section, key) });
    if (mode === "all")
        for (const c of CONF_SETTINGS)
            if (!nfs.conf.get(c.section)?.has(c.key))
                rows.push({ section: c.section, key: c.key, setting: c });
    rows.sort((a, b) => `${a.section}.${a.key}`.localeCompare(`${b.section}.${b.key}`));

    return (
        <Card isPlain className="ct-card" id="nfs-conf-all">
            <CardHeader actions={{
                actions: (
                    <>
                        <Button variant={mode === "set" ? "secondary" : "link"} onClick={() => setMode(mode === "set" ? "all" : "set")}>
                            {mode === "set" ? _("Show every setting") : _("Show the settings that are set")}
                        </Button>
                        {nfs.admin && nfs.env?.tools.nfsconf &&
                            <Button variant="secondary" id="nfs-conf-add" onClick={() => Dialogs.show(<OneSettingDialog section="" keyName="" isNew />)}>
                                {_("Add a setting")}
                            </Button>}
                    </>),
            }}>
                <CardTitle component="h2" className="shares-group-description">
                    {cockpit.format(_("Settings of $0 and $1, as read by nfsconf."), NFS_CONF, "/etc/nfs.conf.d")}
                </CardTitle>
            </CardHeader>
            <ListingTable aria-label={_("All settings")} variant="compact"
                          columns={[_("Section"), _("Setting"), _("Value"), _("Default"), { title: "", props: { screenReaderText: _("Actions") } }]}
                          emptyCaption={_("No setting is set: every default applies.")}
                          rows={rows.map(r => {
                              const v = nfs.conf.get(r.section)?.get(r.key);
                              return {
                                  props: { key: `${r.section}.${r.key}` },
                                  columns: [
                                      <code key="s">{r.section}</code>,
                                      { title: <>{r.setting?.label() ?? <code>{r.key}</code>}{r.setting && <code className="shares-param-name"> {r.key}</code>}{!known.has(`${r.section}.${r.key}`) && <span className="shares-muted"> {_("(not described here)")}</span>}</> },
                                      v !== undefined ? <span className="shares-param-value" key="v">{displayConf(r.setting, v)}</span> : "",
                                      <span className="shares-param-fallback" key="d">{r.setting ? displayConf(r.setting, r.setting.default) : ""}</span>,
                                      {
                                          title: nfs.admin && nfs.env?.tools.nfsconf
                                              ? <KebabDropdown toggleButtonId={`nfs-conf-actions-${r.section}-${r.key}`.replace(/\W+/g, "-")} dropdownItems={[
                                                  <DropdownItem key="edit" onClick={() => Dialogs.show(<OneSettingDialog section={r.section} keyName={r.key} />)}>{_("Edit")}</DropdownItem>,
                                                  ...(v !== undefined
                                                      ? [<DropdownItem key="reset" onClick={() => Dialogs.show(
                                                          <ConfirmDialog id="nfs-conf-reset" title={cockpit.format(_("Reset $0?"), `[${r.section}] ${r.key}`)}
                                                                         body={_("The setting is removed from nfs.conf and the default applies.")}
                                                                         confirmLabel={_("Reset")} isDanger={false}
                                                                         onConfirm={() => nfs.saveConf([{ section: r.section, key: r.key, value: null }])} />)}>
                                                          {_("Reset to default")}
                                                      </DropdownItem>]
                                                      : []),
                                              ]} />
                                              : null,
                                          props: { className: "pf-v6-c-table__action" },
                                      },
                                  ],
                              };
                          })} />
        </Card>
    );
};

export const NfsSettingsPage = () => {
    const nfs = useNfs();
    return (
        <Page id="nfs-settings-page" className="pf-m-no-sidebar">
            <PageBreadcrumb hasBodyWrapper={false} stickyOnBreakpoint={{ default: "top" }}>
                <Breadcrumb>
                    <BreadcrumbItem to="#/">{_("File sharing")}</BreadcrumbItem>
                    <BreadcrumbItem isActive>{_("NFS server settings")}</BreadcrumbItem>
                </Breadcrumb>
            </PageBreadcrumb>
            <PageSection hasBodyWrapper={false}>
                {!nfs.env
                    ? <EmptyStatePanel loading />
                    : (
                        <Stack hasGutter>
                            <NfsNotices />
                            {!nfs.env.tools.nfsconf &&
                                <EmptyStatePanel title={_("nfsconf is not available")}
                                                 paragraph={_("This version of nfs-utils has no nfsconf; the settings cannot be changed here.")} />}
                            <SectionTabs id="nfs-settings-tabs" tabs={[
                                { key: "server", title: SERVER.title(), content: <ConfGroupCard group={SERVER} /> },
                                { key: "ports", title: PORTS.title(), content: <ConfGroupCard group={PORTS} /> },
                                { key: "all", title: _("All settings"), count: Array.from(nfs.conf.values()).reduce((n, s) => n + s.size, 0), content: <AllSettings /> },
                            ]} />
                        </Stack>)}
            </PageSection>
        </Page>
    );
};
