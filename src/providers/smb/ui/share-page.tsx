/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Details of one SMB share.
 */

import React, { useEffect, useState } from "react";
import cockpit from "cockpit";

import { Alert, AlertActionLink } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Breadcrumb, BreadcrumbItem } from "@patternfly/react-core/dist/esm/components/Breadcrumb/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { ClipboardCopy } from "@patternfly/react-core/dist/esm/components/ClipboardCopy/index.js";
import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Page, PageBreadcrumb, PageSection } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import { useDialogs } from "dialogs";
import { EmptyStatePanel } from "cockpit-components-empty-state";
import { ListingTable } from "cockpit-components-table";

import { useSmb, type SmbState } from "../state.tsx";
import { parseBoolean, splitList, isGlobalSection } from "../smbconf.ts";
import {
    statPath, createDirectory, getSelinuxBooleans, labelForSamba, setSelinuxBoolean, closeShare,
} from "../backend.ts";
import { selinuxType, SELINUX_SHAREABLE_TYPES, type PathInfo } from "../parsers.ts";
import { ErrorAlert, formatDate } from "../../../lib/utils.tsx";
import { SHARE_GENERAL, SHARE_ACCESS, SHARE_PERMISSIONS, type FieldGroup } from "./labels.ts";
import { FieldGroupDialog, ConfirmDialog, fallbackValue } from "./dialogs.tsx";
import { displayValue, definitionOf } from "./param-field.tsx";
import { SectionTabs } from "./tabs.tsx";
import { ParameterTable } from "./param-table.tsx";
import { VfsCard } from "./vfs-card.tsx";
import { ShareActions, specialLabel, setShareEnabled, useSmbStatus, netbiosName } from "./shares.tsx";
import { SmbNotices } from "./status-card.tsx";

const _ = cockpit.gettext;

/** Number of parameters of a group that are set in the section. */
export function customizedCount(smb: SmbState, section: string, group: FieldGroup): number {
    return group.fields.filter(f => smb.config.conf.get(section, f.name) !== undefined).length;
}

/** One group of curated parameters, full width, with its Edit dialog. */
export const FieldGroupCard = ({ section, group, id }: { section: string, group: FieldGroup, id: string }) => {
    const smb = useSmb();
    const Dialogs = useDialogs();
    const global = isGlobalSection(section);
    return (
        <Card isPlain className="ct-card shares-group" id={id}>
            <CardHeader actions={{
                actions: smb.admin
                    ? <Button variant="secondary" id={id + "-edit"} onClick={() => Dialogs.show(<FieldGroupDialog section={section} group={group} />)}>{_("Edit")}</Button>
                    : null,
            }}>
                <CardTitle component="h2" className="shares-group-description">{group.description()}</CardTitle>
            </CardHeader>
            <CardBody>
                <DescriptionList isHorizontal isCompact className="shares-settings"
                                 horizontalTermWidthModifier={{ default: "14rem", lg: "20rem" }}>
                    {group.fields.map(f => {
                        const def = definitionOf(f.name);
                        if (!global && def && "context" in def && def.context === "G")
                            return null;
                        const explicit = smb.config.conf.get(section, f.name);
                        const fallback = fallbackValue(smb, section, f.name);
                        let shown: React.ReactNode;
                        if (explicit !== undefined) {
                            shown = <span className="shares-param-value">{displayValue(f.name, explicit) || <em>{_("empty")}</em>}</span>;
                        } else {
                            const text = fallback
                                ? displayValue(f.name, fallback)
                                : (f.kind === "principals" ? (f.name === "valid users" ? _("Everyone") : _("Nobody")) : _("not set"));
                            shown = (
                                <span className="shares-param-fallback">
                                    {text}
                                    {fallback ? <span className="shares-param-origin">{global ? _("Samba default") : _("inherited")}</span> : null}
                                </span>
                            );
                        }
                        return (
                            <DescriptionListGroup key={f.name}>
                                <DescriptionListTerm>{f.label()}</DescriptionListTerm>
                                <DescriptionListDescription data-param={f.name}>{shown}</DescriptionListDescription>
                            </DescriptionListGroup>
                        );
                    })}
                </DescriptionList>
            </CardBody>
        </Card>
    );
};

const PathChecks = ({ smb, share, path }: { smb: SmbState, share: string, path: string }) => {
    const [info, setInfo] = useState<PathInfo | null>(null);
    const [booleans, setBooleans] = useState<Record<string, boolean>>({});
    const [generation, setGeneration] = useState(0);
    const [error, setError] = useState<unknown>(null);
    const [busy, setBusy] = useState(false);
    const env = smb.env!;
    const homes = share.toLowerCase() === "homes";

    useEffect(() => {
        if (!path || path.includes("%"))
            return;
        statPath(path, env).then(setInfo);
        if (env.selinux !== "disabled")
            getSelinuxBooleans(["samba_export_all_rw", "samba_export_all_ro", "samba_enable_home_dirs"]).then(setBooleans);
    }, [path, env, generation]);

    const act = (f: () => Promise<unknown>) => {
        setBusy(true);
        setError(null);
        f().then(() => setGeneration(g => g + 1))
                .catch(setError)
                .finally(() => setBusy(false));
    };

    const alerts = [];
    if (homes && env.selinux !== "disabled" && booleans.samba_enable_home_dirs === false) {
        alerts.push(
            <Alert key="homes" variant="warning" isInline title={_("SELinux prevents Samba from sharing home directories")}
                   actionLinks={smb.admin && <AlertActionLink isDisabled={busy} onClick={() => act(() => setSelinuxBoolean("samba_enable_home_dirs", true))}>{_("Allow")}</AlertActionLink>}
            >
                {_("The samba_enable_home_dirs boolean is off.")}
            </Alert>);
    }
    if (info && !info.exists && !path.includes("%")) {
        alerts.push(
            <Alert key="missing" variant="danger" isInline title={_("The directory does not exist")}
                   actionLinks={smb.admin && <AlertActionLink isDisabled={busy} onClick={() => act(() => createDirectory(path, "root", "root", "0755"))}>{_("Create it")}</AlertActionLink>}
            >
                {_("Clients cannot connect to this share until the directory exists.")}
            </Alert>);
    } else if (info && !info.isDirectory) {
        alerts.push(<Alert key="notdir" variant="danger" isInline title={_("The path is not a directory")} />);
    } else if (info && env.selinux !== "disabled" && !homes) {
        const type = selinuxType(info.selinuxContext);
        const readOnly = parseBoolean(smb.config.conf.get(share, "read only") ?? smb.inherited("read only") ?? "yes") !== false;
        const allowed = (type && SELINUX_SHAREABLE_TYPES.includes(type)) || booleans.samba_export_all_rw ||
            (readOnly && booleans.samba_export_all_ro);
        if (type && !allowed) {
            alerts.push(
                <Alert key="selinux" variant="warning" isInline
                       title={cockpit.format(_("SELinux prevents Samba from accessing this directory (type $0)"), type)}
                       actionLinks={smb.admin &&
                           <AlertActionLink isDisabled={busy} onClick={() => act(() => labelForSamba(path, env))}>
                               {_("Label the directory for Samba")}
                           </AlertActionLink>}
                >
                    {env.tools.semanage
                        ? _("The directory tree gets the samba_share_t type, persistently (semanage fcontext and restorecon).")
                        : _("The directory tree gets the samba_share_t type with chcon. Install semanage to make it survive a relabel.")}
                </Alert>);
        }
    }
    return (
        <>
            {!!error && <ErrorAlert error={error} />}
            {alerts}
            {info?.exists && info.isDirectory &&
                <span className="shares-muted" id="smb-share-path-info">
                    {cockpit.format(_("Owner $0, group $1, permissions $2"), info.owner, info.group, info.mode)}
                    {info.selinuxContext && " · " + selinuxType(info.selinuxContext)}
                </span>}
        </>
    );
};

const Connections = ({ smb, share }: { smb: SmbState, share: string }) => {
    const Dialogs = useDialogs();
    const { status, refresh } = useSmbStatus(smb, 10000);
    if (!smb.admin)
        return null;
    const tcons = (status?.tcons ?? []).filter(t => t.service.toLowerCase() === share.toLowerCase());
    const sessions = new Map((status?.sessions ?? []).map(s => [s.id, s]));
    const pidSessions = new Map((status?.sessions ?? []).map(s => [s.pid, s]));
    return (
        <Card isPlain className="ct-card" id="smb-share-connections">
            <CardHeader actions={{
                actions: tcons.length > 0 && (
                    <Button variant="secondary" onClick={() => Dialogs.show(
                        <ConfirmDialog id="smb-close-share" title={_("Disconnect every client?")}
                                       body={_("Open files may lose unsaved changes. Clients usually reconnect automatically.")}
                                       confirmLabel={_("Disconnect")}
                                       onConfirm={async () => { await closeShare(share); refresh() }}
                        />)}
                    >
                        {_("Disconnect all")}
                    </Button>),
            }}
            >
                <CardTitle component="h2" className="shares-group-description">{_("Clients connected to this share right now.")}</CardTitle>
            </CardHeader>
            <ListingTable aria-label={_("Connected clients")} variant="compact"
                          columns={[_("User"), _("Computer"), _("Protocol"), _("Connected since")]}
                          loading={status === null ? _("Loading...") : ""}
                          emptyCaption={_("No client is connected to this share")}
                          rows={tcons.map(t => {
                              const s = sessions.get(t.sessionId) ?? pidSessions.get(t.pid);
                              return {
                                  props: { key: t.id },
                                  columns: [
                                      s?.username ?? "",
                                      t.machine,
                                      s?.dialect ?? "",
                                      t.connectedAt ? formatDate(new Date(t.connectedAt)) : "",
                                  ],
                              };
                          })}
            />
        </Card>
    );
};

export const SmbSharePage = ({ name }: { name: string }) => {
    const smb = useSmb();
    const [toggleError, setToggleError] = useState<unknown>(null);
    const [busy, setBusy] = useState(false);

    const breadcrumb = (
        <PageBreadcrumb hasBodyWrapper={false} stickyOnBreakpoint={{ default: "top" }}>
            <Breadcrumb>
                <BreadcrumbItem to="#/">{_("File sharing")}</BreadcrumbItem>
                <BreadcrumbItem isActive>{name}</BreadcrumbItem>
            </Breadcrumb>
        </PageBreadcrumb>
    );

    if (!smb.env || !smb.config.loaded) {
        return <Page className="pf-m-no-sidebar">{breadcrumb}<PageSection hasBodyWrapper={false}><EmptyStatePanel loading /></PageSection></Page>;
    }

    const inFile = smb.config.conf.hasSection(name);
    const external = !inFile && (smb.effective?.dump?.hasSection(name) ?? false);
    if (!inFile && !external) {
        return (
            <Page className="pf-m-no-sidebar">
                {breadcrumb}
                <PageSection hasBodyWrapper={false}>
                    <EmptyStatePanel title={cockpit.format(_("Share $0 does not exist"), name)}
                                     action={_("Back to file sharing")} actionVariant="link" onAction={() => cockpit.location.go("/")}
                    />
                </PageSection>
            </Page>
        );
    }

    const canonical = inFile ? smb.config.conf.section(name)!.name : name;
    const get = (n: string) => inFile ? smb.config.conf.get(canonical, n) : smb.effective!.dump!.get(canonical, n);
    const value = (n: string) => get(n) ?? smb.inherited(n);
    const enabled = parseBoolean(value("available") ?? "yes") !== false;
    const path = get("path") ?? "";
    const special = specialLabel(canonical);
    const server = netbiosName(smb);
    const host = cockpit.transport.host === "localhost" ? window.location.hostname : cockpit.transport.host;

    const toggle = (on: boolean) => {
        setBusy(true);
        setToggleError(null);
        setShareEnabled(smb, canonical, on).catch(setToggleError)
                .finally(() => setBusy(false));
    };

    return (
        <Page id="smb-share-page" className="pf-m-no-sidebar">
            {breadcrumb}
            <PageSection hasBodyWrapper={false}>
                <Stack hasGutter>
                    <SmbNotices />
                    {external &&
                        <Alert variant="info" isInline title={_("This share is defined outside smb.conf")}>
                            {_("It comes from an included file or from the registry configuration and is shown read only.")}
                        </Alert>}
                    {canonical.toLowerCase() === "homes" &&
                        <Alert variant="info" isInline title={_("Special section: home directories")}>
                            {_("Every user connecting to \\\\server\\username gets their home directory; the settings below apply to all of them.")}
                        </Alert>}
                    {canonical.toLowerCase() === "printers" &&
                        <Alert variant="info" isInline title={_("Special section: printers")}>
                            {_("Every printer of the print system is shared with these settings.")}
                        </Alert>}
                    <Card isPlain className="ct-card" id="smb-share-overview">
                        <CardHeader actions={{
                            actions: (
                                <Flex alignItems={{ default: "alignItemsCenter" }}>
                                    {inFile && smb.admin &&
                                        <Switch id="smb-share-enabled" label={_("Enabled")} isChecked={enabled} isDisabled={busy}
                                                onChange={(_ev, on) => toggle(on)}
                                        />}
                                    <ShareActions name={canonical} external={external} onDetails={false} />
                                </Flex>),
                        }}
                        >
                            <CardTitle component="h2">
                                <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }}>
                                    <FlexItem>{canonical}</FlexItem>
                                    <FlexItem><Label isCompact color="grey">SMB</Label></FlexItem>
                                    {special && <FlexItem><Label isCompact variant="outline">{special}</Label></FlexItem>}
                                    {!enabled && <FlexItem><Label isCompact color="orange">{_("Disabled")}</Label></FlexItem>}
                                </Flex>
                            </CardTitle>
                        </CardHeader>
                        <CardBody>
                            <Stack hasGutter>
                                {!!toggleError && <ErrorAlert error={toggleError} />}
                                <DescriptionList isHorizontal isCompact horizontalTermWidthModifier={{ default: "14rem", lg: "20rem" }}>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("Path")}</DescriptionListTerm>
                                        <DescriptionListDescription id="smb-share-path">
                                            <Stack hasGutter>
                                                <code>{path || (canonical.toLowerCase() === "homes" ? _("Each user's home directory") : _("not set"))}</code>
                                                {path && <PathChecks smb={smb} share={canonical} path={path} />}
                                            </Stack>
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                    {get("comment") &&
                                        <DescriptionListGroup>
                                            <DescriptionListTerm>{_("Description")}</DescriptionListTerm>
                                            <DescriptionListDescription>{get("comment")}</DescriptionListDescription>
                                        </DescriptionListGroup>}
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("Windows address")}</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            <ClipboardCopy isReadOnly variant="inline-compact" hoverTip={_("Copy")} clickTip={_("Copied")}>
                                                {`\\\\${server}\\${canonical}`}
                                            </ClipboardCopy>
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("macOS and Linux address")}</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            <ClipboardCopy isReadOnly variant="inline-compact" hoverTip={_("Copy")} clickTip={_("Copied")}>
                                                {`smb://${host}/${encodeURIComponent(canonical)}`}
                                            </ClipboardCopy>
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                </DescriptionList>
                            </Stack>
                        </CardBody>
                    </Card>
                    {inFile
                        ? <SectionTabs id="smb-share-tabs" tabs={[
                            { key: "general", title: SHARE_GENERAL.title(), count: customizedCount(smb, canonical, SHARE_GENERAL), content: <FieldGroupCard section={canonical} group={SHARE_GENERAL} id="smb-share-general" /> },
                            { key: "access", title: SHARE_ACCESS.title(), count: customizedCount(smb, canonical, SHARE_ACCESS), content: <FieldGroupCard section={canonical} group={SHARE_ACCESS} id="smb-share-access" /> },
                            { key: "permissions", title: SHARE_PERMISSIONS.title(), count: customizedCount(smb, canonical, SHARE_PERMISSIONS), content: <FieldGroupCard section={canonical} group={SHARE_PERMISSIONS} id="smb-share-permissions" /> },
                            { key: "vfs", title: _("VFS modules"), count: splitList(smb.config.conf.get(canonical, "vfs objects") ?? "").length, content: <VfsCard section={canonical} /> },
                            ...(smb.admin ? [{ key: "clients", title: _("Connected clients"), content: <Connections smb={smb} share={canonical} /> }] : []),
                            { key: "parameters", title: _("All parameters"), count: smb.config.conf.section(canonical)?.parameters.size, content: <ParameterTable section={canonical} /> },
                        ]} />
                        : <Connections smb={smb} share={canonical} />}
                </Stack>
            </PageSection>
        </Page>
    );
};
