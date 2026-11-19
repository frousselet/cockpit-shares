/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * The SMB (Samba) share provider.
 */

import React from "react";
import cockpit from "cockpit";

import type { ShareProvider } from "../types.ts";
import { SmbProvider, useSmb } from "./state.tsx";
import { SmbStatusCard } from "./ui/status-card.tsx";
import { SmbUsersCard } from "./ui/users-card.tsx";
import { SmbSessionsCard } from "./ui/sessions-card.tsx";
import { SmbSharePage } from "./ui/share-page.tsx";
import { SmbGlobalPage } from "./ui/global-page.tsx";
import { SmbHistoryPage } from "./ui/history-page.tsx";
import { CreateShareDialog, ShareActions, summarize, useSmbStatus } from "./ui/shares.tsx";

const _ = cockpit.gettext;

const OverviewCards = () => (
    <>
        <SmbUsersCard />
        <SmbSessionsCard />
    </>
);

export const smbProvider: ShareProvider = {
    id: "smb",
    label: "SMB",
    description: () => _("SMB share (Windows, macOS, Linux)"),
    Root: SmbProvider,
    useShares: () => {
        const smb = useSmb();
        const { status } = useSmbStatus(smb, 10000);
        return {
            loading: !smb.env || (smb.env.installed && !smb.config.loaded),
            available: !!smb.env?.installed,
            shares: smb.env?.installed ? summarize(smb, status) : [],
        };
    },
    StatusCard: SmbStatusCard,
    OverviewCards,
    ShareActions: ({ share }) => <ShareActions name={share.name} external={share.external} />,
    createShare: dialogs => dialogs.show(<CreateShareDialog />),
    useCanCreate: () => {
        const smb = useSmb();
        return !!smb.env?.installed && smb.admin && smb.config.loaded;
    },
    renderPage: path => {
        if (path.length === 2 && path[0] === "share")
            return <SmbSharePage name={path[1]} />;
        if (path.length === 1 && path[0] === "settings")
            return <SmbGlobalPage />;
        if (path.length === 1 && path[0] === "history")
            return <SmbHistoryPage />;
        return null;
    },
};
