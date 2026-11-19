/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * History of the smb.conf versions saved before each change made by this
 * page, with comparison and restoration. The file itself is never edited as
 * text: every change goes through the forms.
 */

import React, { useEffect, useState } from "react";
import cockpit from "cockpit";

import { Breadcrumb, BreadcrumbItem } from "@patternfly/react-core/dist/esm/components/Breadcrumb/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Page, PageBreadcrumb, PageSection } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import { useDialogs } from "dialogs";
import { ListingTable } from "cockpit-components-table";
import { EmptyStatePanel } from "cockpit-components-empty-state";

import { useSmb } from "../state.tsx";
import { listBackups, readFile, BACKUP_DIR, type Backup } from "../backend.ts";
import { ErrorAlert, formatDate } from "../../../lib/utils.tsx";
import { lineDiff } from "../../../lib/diff.ts";
import { reportSave } from "./dialogs.tsx";
import { SmbNotices } from "./status-card.tsx";

const _ = cockpit.gettext;

const DiffView = ({ from, to }: { from: string, to: string }) => {
    const lines = lineDiff(from, to);
    if (!lines.some(l => l.kind !== "same"))
        return <p>{_("No difference.")}</p>;
    return (
        <pre className="shares-diff">
            {lines.map((l, i) => l.kind === "skip"
                ? <div key={i} className="shares-diff-skip">{cockpit.format(_("… $0 unchanged lines"), l.count)}</div>
                : <div key={i} className={"shares-diff-" + l.kind}>{(l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  ") + l.text}</div>)}
        </pre>
    );
};

const BackupDialog = ({ backup, current, onRestore }: { backup: Backup, current: string, onRestore: (text: string) => Promise<void> }) => {
    const Dialogs = useDialogs();
    const [text, setText] = useState<string | null>(null);
    const [error, setError] = useState<unknown>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        readFile(backup.file).then(setText)
                .catch(setError);
    }, [backup.file]);
    return (
        <Modal id="smb-backup-dialog" position="top" variant="large" isOpen onClose={Dialogs.close} aria-labelledby="smb-backup-title">
            <ModalHeader title={cockpit.format(_("Version of $0"), formatDate(backup.date))} labelId="smb-backup-title"
                         description={_("Changes needed to go back to this version.")} />
            <ModalBody>
                {!!error && <ErrorAlert error={error} />}
                {text === null ? <EmptyStatePanel loading /> : <DiffView from={current} to={text} />}
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" id="smb-backup-restore" isDisabled={text === null || busy} isLoading={busy}
                        onClick={() => {
                            setBusy(true);
                            onRestore(text!).then(() => Dialogs.close())
                                    .catch(ex => { setError(ex); setBusy(false) });
                        }}>
                    {_("Restore this version")}
                </Button>
                <Button variant="link" onClick={Dialogs.close}>{_("Close")}</Button>
            </ModalFooter>
        </Modal>
    );
};

export const SmbHistoryPage = () => {
    const smb = useSmb();
    const Dialogs = useDialogs();
    const [backups, setBackups] = useState<Backup[] | null>(null);

    useEffect(() => {
        if (smb.env && smb.admin)
            listBackups(smb.env).then(setBackups);
    }, [smb.env, smb.admin, smb.config.tag]);

    // restoring goes through the same validation, backup and reload as any change
    const restore = async (text: string) => {
        const result = await smb.saveText(text);
        reportSave(smb, result);
    };

    return (
        <Page id="smb-history-page" className="pf-m-no-sidebar">
            <PageBreadcrumb hasBodyWrapper={false} stickyOnBreakpoint={{ default: "top" }}>
                <Breadcrumb>
                    <BreadcrumbItem to="#/">{_("File sharing")}</BreadcrumbItem>
                    <BreadcrumbItem isActive>{_("History of changes")}</BreadcrumbItem>
                </Breadcrumb>
            </PageBreadcrumb>
            <PageSection hasBodyWrapper={false}>
                <Stack hasGutter>
                    <SmbNotices />
                    <Card isPlain className="ct-card" id="smb-config-history">
                        <CardHeader>
                            <CardTitle component="h2">{_("History of changes")}</CardTitle>
                        </CardHeader>
                        {!smb.admin
                            ? <EmptyStatePanel title={_("Administrative access is required to see the history.")} headingLevel="h3" />
                            : <ListingTable aria-label={_("History of changes")} variant="compact"
                                            columns={[_("Date of the change"), _("Saved copy"), { title: "", props: { screenReaderText: _("Actions") } }]}
                                            loading={backups === null ? _("Loading...") : ""}
                                            emptyCaption={_("No previous version")}
                                            emptyCaptionDetail={cockpit.format(_("A copy of the configuration is kept in $0 before every change made here."), BACKUP_DIR)}
                                            rows={(backups ?? []).map(b => ({
                                                props: { key: b.file },
                                                columns: [
                                                    formatDate(b.date),
                                                    <code key="f">{b.file}</code>,
                                                    {
                                                        title: (
                                                            <Button variant="secondary" size="sm"
                                                                    onClick={() => Dialogs.show(<BackupDialog backup={b} current={smb.config.text} onRestore={restore} />)}>
                                                                {_("Compare")}
                                                            </Button>),
                                                        props: { className: "pf-v6-c-table__action" },
                                                    },
                                                ],
                                            }))} />}
                    </Card>
                </Stack>
            </PageSection>
        </Page>
    );
};
