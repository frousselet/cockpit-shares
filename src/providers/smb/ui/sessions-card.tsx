/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Connected SMB clients and open files (smbstatus).
 */

import React from "react";
import cockpit from "cockpit";

import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { ExpandableSection } from "@patternfly/react-core/dist/esm/components/ExpandableSection/index.js";

import { useDialogs } from "dialogs";
import { ListingTable } from "cockpit-components-table";

import { useSmb } from "../state.tsx";
import { disconnectProcess } from "../backend.ts";
import { ErrorAlert, formatDate } from "../../../lib/utils.tsx";
import { ConfirmDialog } from "./dialogs.tsx";
import { useSmbStatus } from "./shares.tsx";

const _ = cockpit.gettext;

export const SmbSessionsCard = () => {
    const smb = useSmb();
    const Dialogs = useDialogs();
    const { status, error, refresh } = useSmbStatus(smb, 5000);

    if (!smb.env?.installed || !smb.admin)
        return null;

    const rows = (status?.sessions ?? []).map(s => {
        const shares = (status?.tcons ?? []).filter(t => t.sessionId === s.id || (!t.sessionId && t.pid === s.pid)).map(t => t.service);
        const files = (status?.openFiles ?? []).filter(f => f.pid === s.pid);
        const encrypted = s.encryption && s.encryption.cipher && s.encryption.cipher !== "-";
        return {
            props: { key: s.id + s.pid },
            columns: [
                s.username,
                s.remoteMachine,
                { title: <>{s.dialect} {encrypted && <Label isCompact color="green">{_("Encrypted")}</Label>}</> },
                Array.from(new Set(shares)).join(", "),
                String(files.length),
                {
                    title: (
                        <Button variant="secondary" size="sm" onClick={() => Dialogs.show(
                            <ConfirmDialog id="smb-session-kill" title={cockpit.format(_("Disconnect $0?"), s.username)}
                                           body={_("The client loses its open files and may reconnect automatically.")}
                                           confirmLabel={_("Disconnect")}
                                           onConfirm={async () => { await disconnectProcess(s.pid); refresh() }}
                            />)}
                        >
                            {_("Disconnect")}
                        </Button>),
                    props: { className: "pf-v6-c-table__action" },
                },
            ],
            expandedContent: files.length
                ? (
                    <ListingTable aria-label={_("Open files")} variant="compact"
                                  columns={[_("File"), _("Access"), _("Opened")]}
                                  rows={files.map((f, i) => ({
                                      props: { key: i },
                                      columns: [<code key="p">{f.path}</code>, f.access, f.openedAt ? formatDate(new Date(f.openedAt)) : ""],
                                  }))}
                    />)
                : undefined,
        };
    });

    return (
        <Card isPlain className="ct-card" id="smb-sessions">
            <CardHeader>
                <CardTitle component="h2">{_("SMB clients")}</CardTitle>
            </CardHeader>
            {!!error && <CardBody><ErrorAlert error={error} /></CardBody>}
            <ListingTable aria-label={_("Connected clients")} variant="compact" id="smb-sessions-list"
                          columns={[_("User"), _("Computer"), _("Protocol"), _("Shares"), _("Open files"), { title: "", props: { screenReaderText: _("Actions") } }]}
                          rows={rows}
                          loading={status === null && !error ? _("Loading...") : ""}
                          emptyCaption={_("No client is connected")}
            />
            {status && status.openFiles.length > 0 &&
                <CardBody>
                    <ExpandableSection toggleText={cockpit.format(cockpit.ngettext("$0 open file", "$0 open files", status.openFiles.length), status.openFiles.length)}>
                        <ListingTable aria-label={_("Open files")} variant="compact"
                                      columns={[_("File"), _("User"), _("Access"), _("Opened")]}
                                      rows={status.openFiles.map((f, i) => ({
                                          props: { key: i },
                                          columns: [
                                              <code key="p">{f.path}</code>,
                                              status.sessions.find(s => s.pid === f.pid)?.username ?? String(f.uid),
                                              f.access,
                                              f.openedAt ? formatDate(new Date(f.openedAt)) : "",
                                          ],
                                      }))}
                        />
                    </ExpandableSection>
                </CardBody>}
        </Card>
    );
};
