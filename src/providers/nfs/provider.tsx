/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * The NFS (kernel server, nfs-utils) share provider.
 */

import React from "react";
import cockpit from "cockpit";

import type { ShareProvider } from "../types.ts";
import { HistoryPage } from "../../lib/history.tsx";
import { writeConfigFile, readFile } from "../../lib/system.ts";
import { NfsProvider, useNfs } from "./state.tsx";
import { NFS_CONF } from "./backend.ts";
import { NfsStatusCard } from "./ui/status-card.tsx";
import { NfsClientsCard } from "./ui/clients-card.tsx";
import { NfsExportPage } from "./ui/export-page.tsx";
import { NfsSettingsPage } from "./ui/settings-page.tsx";
import { CreateExportDialog, ExportActions, summarize } from "./ui/exports.tsx";
import { NfsNotices } from "./ui/common.tsx";

const _ = cockpit.gettext;

const NfsHistoryPage = () => {
    const nfs = useNfs();
    const [confText, setConfText] = React.useState("");
    React.useEffect(() => {
        readFile(NFS_CONF, "try").then(setConfText)
                .catch(() => setConfText(""));
    }, [nfs.conf]);
    const sources = [...nfs.files.map(f => f.path), NFS_CONF];
    return (
        <HistoryPage id="nfs-history-page" sources={sources} admin={nfs.admin}
                     generation={nfs.files.map(f => f.tag).join(",") + confText.length}
                     current={source => (source === NFS_CONF ? confText : nfs.files.find(f => f.path === source)?.text ?? "")}
                     restore={async (source, text) => {
                         if (source === NFS_CONF) {
                             await writeConfigFile(NFS_CONF, text, null);
                             nfs.notify({ variant: "info", title: _("Restart the NFS server to apply the new settings"), restart: true });
                             nfs.refreshEnvironment();
                         } else {
                             await nfs.saveExportsText(source, text);
                         }
                     }}
                     notices={<NfsNotices />} />
    );
};

export const nfsProvider: ShareProvider = {
    id: "nfs",
    label: "NFS",
    description: () => _("NFS export (Linux, UNIX)"),
    Root: NfsProvider,
    useShares: () => {
        const nfs = useNfs();
        return {
            loading: !nfs.env || (nfs.env.installed && !nfs.loaded),
            available: !!nfs.env?.installed,
            shares: nfs.env?.installed ? summarize(nfs) : [],
        };
    },
    StatusCard: NfsStatusCard,
    OverviewCards: NfsClientsCard,
    ShareActions: ExportActions,
    createShare: dialogs => dialogs.show(<CreateExportDialog />),
    useCanCreate: () => {
        const nfs = useNfs();
        return !!nfs.env?.installed && nfs.admin && nfs.loaded;
    },
    renderPage: path => {
        if (path.length === 2 && path[0] === "export")
            return <NfsExportPage path={path[1]} />;
        if (path.length === 1 && path[0] === "settings")
            return <NfsSettingsPage />;
        if (path.length === 1 && path[0] === "history")
            return <NfsHistoryPage />;
        return null;
    },
};
