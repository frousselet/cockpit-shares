/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Details of one NFS export.
 */

import React, { useEffect, useState } from "react";
import cockpit from "cockpit";

import { Alert, AlertActionLink } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Breadcrumb, BreadcrumbItem } from "@patternfly/react-core/dist/esm/components/Breadcrumb/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { ClipboardCopy } from "@patternfly/react-core/dist/esm/components/ClipboardCopy/index.js";
import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { DropdownItem } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { Divider } from "@patternfly/react-core/dist/esm/components/Divider/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { LabelGroup } from "@patternfly/react-core/dist/esm/components/Label/LabelGroup.js";
import { Page, PageBreadcrumb, PageSection } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import { useDialogs } from "dialogs";
import { usePageLocation } from "hooks";
import { EmptyStatePanel } from "cockpit-components-empty-state";
import { ListingTable } from "cockpit-components-table";
import { KebabDropdown } from "cockpit-components-dropdown";

import { useNfs } from "../state.tsx";
import { mountOf, pathExists, type MountInfo } from "../backend.ts";
import { createDirectory } from "../../../lib/system.ts";
import { ErrorAlert } from "../../../lib/utils.tsx";
import { ConfirmDialog } from "../../smb/ui/dialogs.tsx";
import { SectionTabs } from "../../smb/ui/tabs.tsx";
import { EXPORT_OPTIONS, readOption, otherOptions, choiceLabel, type ChoiceOption } from "./options.ts";
import { ClientDialog } from "./client-dialog.tsx";
import { deleteExport, changePath, CommentDialog } from "./exports.tsx";
import { NfsNotices, clients, hostLabel, isReadWrite, securityFlavors } from "./common.tsx";

const _ = cockpit.gettext;

const choice = (id: string) => EXPORT_OPTIONS.find(o => o.id === id) as ChoiceOption;

/** Options shown in their own column of the clients table. */
const OWN_COLUMN = ["access", "subtree", "sync", "root_squash", "all_squash"];

/** Short description of the options that differ from the defaults. */
function optionSummary(options: string[]): string[] {
    const result: string[] = [];
    for (const opt of EXPORT_OPTIONS) {
        if (OWN_COLUMN.includes(opt.id))
            continue;
        const v = readOption(options, opt);
        if (v === null)
            continue;
        if (opt.kind === "choice") {
            if (v !== opt.values[0].token)
                result.push(v);
        } else if (opt.kind === "flag") {
            result.push(opt.id);
        } else if (opt.id !== "sec") {
            result.push(v === "" ? opt.id : `${opt.id}=${v}`);
        }
    }
    if (readOption(options, choice("sync")) === "async")
        result.unshift("async");
    return [...result, ...otherOptions(options)];
}

const PathInfo = ({ path }: { path: string }) => {
    const nfs = useNfs();
    const [exists, setExists] = useState<boolean | null>(null);
    const [mount, setMount] = useState<MountInfo | null>(null);
    const [generation, setGeneration] = useState(0);
    const [error, setError] = useState<unknown>(null);
    useEffect(() => {
        pathExists(path).then(setExists);
        mountOf(path).then(setMount);
    }, [path, generation]);
    return (
        <Stack hasGutter>
            <code>{path}</code>
            {!!error && <ErrorAlert error={error} />}
            {exists === false &&
                <Alert variant="danger" isInline title={_("The directory does not exist")}
                       actionLinks={nfs.admin &&
                           <AlertActionLink onClick={() => createDirectory(path, "root", "root", "0755")
                                   .then(() => setGeneration(g => g + 1))
                                   .catch(setError)}>
                               {_("Create it")}
                           </AlertActionLink>}>
                    {_("exportfs skips exports whose directory does not exist.")}
                </Alert>}
            {exists && mount &&
                <span className="shares-muted" id="nfs-export-mount">
                    {mount.target === path
                        ? cockpit.format(_("Mount point of $0 ($1)"), mount.source, mount.fstype)
                        : cockpit.format(_("On $0 ($1), mounted at $2"), mount.source, mount.fstype, mount.target)}
                </span>}
        </Stack>
    );
};

export const NfsExportPage = ({ path }: { path: string }) => {
    const nfs = useNfs();
    const Dialogs = useDialogs();
    const { options: location } = usePageLocation();
    const occurrence = Number(location.n ?? 0) || 0;

    const breadcrumb = (
        <PageBreadcrumb hasBodyWrapper={false} stickyOnBreakpoint={{ default: "top" }}>
            <Breadcrumb>
                <BreadcrumbItem to="#/">{_("File sharing")}</BreadcrumbItem>
                <BreadcrumbItem isActive>{path}</BreadcrumbItem>
            </Breadcrumb>
        </PageBreadcrumb>
    );

    if (!nfs.env || !nfs.loaded)
        return <Page className="pf-m-no-sidebar">{breadcrumb}<PageSection hasBodyWrapper={false}><EmptyStatePanel loading /></PageSection></Page>;

    const ref = nfs.find(path, occurrence);
    if (!ref) {
        return (
            <Page className="pf-m-no-sidebar">
                {breadcrumb}
                <PageSection hasBodyWrapper={false}>
                    <EmptyStatePanel title={cockpit.format(_("$0 is not exported"), path)}
                                     action={_("Back to file sharing")} actionVariant="link" onAction={() => cockpit.location.go("/")} />
                </PageSection>
            </Page>
        );
    }

    const fileState = nfs.files.find(f => f.path === ref.file)!;
    const line = fileState.file.lines[ref.index];
    const entry = line.entry!;
    const list = clients(entry);
    const active = nfs.active.filter(a => a.path === path);
    const host = cockpit.transport.host === "localhost" ? window.location.hostname : cockpit.transport.host;

    const actions = nfs.admin
        ? [
            <DropdownItem key="comment" onClick={() => Dialogs.show(<CommentDialog file={ref.file} index={ref.index} entry={entry} />)}>{_("Edit description")}</DropdownItem>,
            <DropdownItem key="path" onClick={() => changePath(Dialogs, nfs, path, occurrence)}>{_("Change path")}</DropdownItem>,
            <Divider key="sep" component="li" />,
            <DropdownItem key="delete" className="pf-m-danger" onClick={() => deleteExport(Dialogs, nfs, path, occurrence, true)}>{_("Delete")}</DropdownItem>,
        ]
        : [];

    const removeItem = (index: number, what: string) => Dialogs.show(
        <ConfirmDialog id="nfs-remove-client" title={cockpit.format(_("Remove $0?"), what)}
                       body={_("This client loses access to the export.")}
                       confirmLabel={_("Remove")}
                       onConfirm={async () => {
                           await nfs.updateExports(ref.file, f => f.replace(ref.index, { ...entry, items: entry.items.filter((_it, i) => i !== index) }));
                       }} />);

    const rows = entry.items.map((item, index) => {
        if (item.kind === "defaults") {
            return {
                props: { key: "d" + index, "data-item": "defaults" },
                columns: [
                    { title: <em>{_("Default options of the line")}</em> },
                    { title: "" }, { title: "" }, { title: "" },
                    { title: <LabelGroup numLabels={6}>{item.options.map(o => <Label key={o} isCompact variant="outline">{o}</Label>)}</LabelGroup> },
                    {
                        title: nfs.admin
                            ? <KebabDropdown toggleButtonId={"nfs-item-actions-" + index} dropdownItems={[
                                <DropdownItem key="edit" onClick={() => Dialogs.show(<ClientDialog file={ref.file} lineIndex={ref.index} entry={entry} itemIndex={index} defaults />)}>{_("Edit")}</DropdownItem>,
                                <DropdownItem key="remove" className="pf-m-danger" onClick={() => removeItem(index, _("the default options"))}>{_("Remove")}</DropdownItem>,
                            ]} />
                            : null,
                        props: { className: "pf-v6-c-table__action" },
                    },
                ],
            };
        }
        const c = list.find(x => x.index === index)!;
        const mapping = readOption(c.options, choice("all_squash")) === "all_squash"
            ? _("Everyone anonymous")
            : choiceLabel(choice("root_squash"), readOption(c.options, choice("root_squash")));
        return {
            props: { key: "c" + index, "data-client": item.host || "*" },
            columns: [
                {
                    title: nfs.admin
                        ? <Button variant="link" isInline onClick={() => Dialogs.show(<ClientDialog file={ref.file} lineIndex={ref.index} entry={entry} itemIndex={index} />)}>{hostLabel(item.host)}</Button>
                        : hostLabel(item.host),
                },
                { title: isReadWrite(c.options) ? _("Read and write") : _("Read only") },
                { title: mapping },
                { title: securityFlavors(c.options).join(", ") },
                { title: <LabelGroup numLabels={6}>{optionSummary(c.options).map(o => <Label key={o} isCompact variant="outline">{o}</Label>)}</LabelGroup> },
                {
                    title: nfs.admin
                        ? <KebabDropdown toggleButtonId={"nfs-item-actions-" + index} dropdownItems={[
                            <DropdownItem key="edit" onClick={() => Dialogs.show(<ClientDialog file={ref.file} lineIndex={ref.index} entry={entry} itemIndex={index} />)}>{_("Edit")}</DropdownItem>,
                            <DropdownItem key="remove" className="pf-m-danger" isDisabled={list.length <= 1}
                                          onClick={() => removeItem(index, hostLabel(item.host))}>{_("Remove")}</DropdownItem>,
                        ]} />
                        : null,
                    props: { className: "pf-v6-c-table__action" },
                },
            ],
        };
    });

    const clientsCard = (
        <Card isPlain className="ct-card" id="nfs-export-clients">
            <CardHeader actions={{
                actions: nfs.admin && (
                    <Button variant="secondary" id="nfs-add-client" onClick={() => Dialogs.show(<ClientDialog file={ref.file} lineIndex={ref.index} entry={entry} itemIndex={null} />)}>
                        {_("Add client")}
                    </Button>),
            }}>
                <CardTitle component="h2" className="shares-group-description">
                    {_("Hosts allowed to mount this directory, with their options. The first matching client applies.")}
                </CardTitle>
            </CardHeader>
            <ListingTable aria-label={_("Clients")} variant="compact" gridBreakPoint="grid-lg"
                          columns={[_("Client"), _("Access"), _("Root of the client"), _("Security"), _("Other options"), { title: "", props: { screenReaderText: _("Actions") } }]}
                          rows={rows} />
        </Card>
    );

    const appliedCard = (
        <Card isPlain className="ct-card" id="nfs-export-applied">
            <CardHeader>
                <CardTitle component="h2" className="shares-group-description">
                    {_("Options in effect according to exportfs, defaults included.")}
                </CardTitle>
            </CardHeader>
            <ListingTable aria-label={_("Applied options")} variant="compact"
                          columns={[_("Client"), _("Options")]}
                          emptyCaption={_("exportfs does not export this directory")}
                          emptyCaptionDetail={_("Check that the directory exists and that the host names resolve.")}
                          rows={active.map((a, i) => ({
                              props: { key: i },
                              columns: [hostLabel(a.client), <code key="o" className="shares-vfs-options">{a.options.join(",")}</code>],
                          }))} />
        </Card>
    );

    return (
        <Page id="nfs-export-page" className="pf-m-no-sidebar">
            {breadcrumb}
            <PageSection hasBodyWrapper={false}>
                <Stack hasGutter>
                    <NfsNotices />
                    {(line.problems ?? []).length > 0 &&
                        <Alert variant="warning" isInline title={_("This line is ambiguous")}>
                            {line.problems!.map((p, i) => <p key={i}>{p}</p>)}
                        </Alert>}
                    <Card isPlain className="ct-card" id="nfs-export-overview">
                        <CardHeader actions={{ actions: actions.length ? <KebabDropdown toggleButtonId="nfs-export-actions" dropdownItems={actions} /> : null }}>
                            <CardTitle component="h2">
                                <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }}>
                                    <FlexItem>{path}</FlexItem>
                                    <FlexItem><Label isCompact color="grey">NFS</Label></FlexItem>
                                    {active.length === 0 && <FlexItem><Label isCompact color="orange">{_("Not exported")}</Label></FlexItem>}
                                </Flex>
                            </CardTitle>
                        </CardHeader>
                        <CardBody>
                            <DescriptionList isHorizontal isCompact horizontalTermWidthModifier={{ default: "14rem", lg: "20rem" }}>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Directory")}</DescriptionListTerm>
                                    <DescriptionListDescription id="nfs-export-path"><PathInfo path={path} /></DescriptionListDescription>
                                </DescriptionListGroup>
                                {entry.comment &&
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("Description")}</DescriptionListTerm>
                                        <DescriptionListDescription>{entry.comment.replace(/^#\s?/, "")}</DescriptionListDescription>
                                    </DescriptionListGroup>}
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Mount command")}</DescriptionListTerm>
                                    <DescriptionListDescription>
                                        <ClipboardCopy isReadOnly variant="inline-compact" hoverTip={_("Copy")} clickTip={_("Copied")}>
                                            {`mount -t nfs ${host}:${path} /mnt`}
                                        </ClipboardCopy>
                                    </DescriptionListDescription>
                                </DescriptionListGroup>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Line of /etc/fstab")}</DescriptionListTerm>
                                    <DescriptionListDescription>
                                        <ClipboardCopy isReadOnly variant="inline-compact" hoverTip={_("Copy")} clickTip={_("Copied")}>
                                            {`${host}:${path} /mnt nfs defaults,_netdev 0 0`}
                                        </ClipboardCopy>
                                    </DescriptionListDescription>
                                </DescriptionListGroup>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Defined in")}</DescriptionListTerm>
                                    <DescriptionListDescription>
                                        <code>{cockpit.format(_("$0, line $1"), ref.file, fileState.file.lines.slice(0, ref.index).reduce((n, l) => n + l.raw.split("\n").length, 1))}</code>
                                    </DescriptionListDescription>
                                </DescriptionListGroup>
                            </DescriptionList>
                        </CardBody>
                    </Card>
                    <SectionTabs id="nfs-export-tabs" tabs={[
                        { key: "clients", title: _("Clients"), count: list.length, content: clientsCard },
                        { key: "applied", title: _("Applied options"), content: appliedCard },
                    ]} />
                </Stack>
            </PageSection>
        </Page>
    );
};
