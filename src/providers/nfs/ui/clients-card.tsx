/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * NFSv4 clients known to the kernel server (/proc/fs/nfsd/clients).
 */

import React, { useEffect, useState } from "react";
import cockpit from "cockpit";

import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";

import { useDialogs } from "dialogs";
import { ListingTable } from "cockpit-components-table";

import { useNfs } from "../state.tsx";
import { listClients, expireClient } from "../backend.ts";
import type { NfsClient } from "../exports.ts";
import { ErrorAlert } from "../../../lib/utils.tsx";
import { ConfirmDialog } from "../../smb/ui/dialogs.tsx";

const _ = cockpit.gettext;

export const NfsClientsCard = () => {
    const nfs = useNfs();
    const Dialogs = useDialogs();
    const [clients, setClients] = useState<NfsClient[] | null | undefined>(undefined);
    const [error, setError] = useState<unknown>(null);
    const [generation, setGeneration] = useState(0);
    const running = !!nfs.env?.kernelVersions;

    useEffect(() => {
        if (!nfs.env?.installed || !nfs.admin || !running)
            return;
        let cancelled = false;
        const poll = () => {
            if (document.visibilityState === "hidden")
                return;
            listClients().then(c => { if (!cancelled) { setClients(c); setError(null) } })
                    .catch(ex => { if (!cancelled) setError(ex); });
        };
        poll();
        const timer = window.setInterval(poll, 10000);
        return () => { cancelled = true; window.clearInterval(timer) };
    }, [nfs.env, nfs.admin, running, generation]);

    if (!nfs.env?.installed || !nfs.admin || !running)
        return null;

    return (
        <Card isPlain className="ct-card" id="nfs-clients">
            <CardHeader>
                <CardTitle component="h2">{_("NFS clients")}</CardTitle>
            </CardHeader>
            {!!error && <CardBody><ErrorAlert error={error} /></CardBody>}
            <ListingTable aria-label={_("NFS clients")} variant="compact"
                          columns={[_("Address"), _("Name"), _("Protocol"), _("Status"), { title: "", props: { screenReaderText: _("Actions") } }]}
                          loading={clients === undefined && !error ? _("Loading...") : ""}
                          emptyCaption={clients === null ? _("This kernel does not list NFS clients") : _("No NFSv4 client is connected")}
                          emptyCaptionDetail={_("NFSv3 clients do not keep a session and are not listed.")}
                          rows={(clients ?? []).map(c => ({
                              props: { key: c.id },
                              columns: [
                                  c.address,
                                  c.name,
                                  c.minorVersion === null ? "" : `NFSv4.${c.minorVersion}`,
                                  c.status,
                                  {
                                      title: (
                                          <Button variant="secondary" size="sm" onClick={() => Dialogs.show(
                                              <ConfirmDialog id="nfs-client-expire" title={cockpit.format(_("Disconnect $0?"), c.address)}
                                                             body={_("The server releases the open files and locks of this client. The client can connect again.")}
                                                             confirmLabel={_("Disconnect")}
                                                             onConfirm={async () => { await expireClient(c.id); setGeneration(g => g + 1) }} />)}>
                                              {_("Disconnect")}
                                          </Button>),
                                      props: { className: "pf-v6-c-table__action" },
                                  },
                              ],
                          }))} />
        </Card>
    );
};
