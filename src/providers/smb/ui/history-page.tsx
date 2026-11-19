/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * History of smb.conf.
 */

import React from "react";

import { HistoryPage } from "../../../lib/history.tsx";
import { useSmb } from "../state.tsx";
import { reportSave } from "./dialogs.tsx";
import { SmbNotices } from "./status-card.tsx";

export const SmbHistoryPage = () => {
    const smb = useSmb();
    const file = smb.env?.configFile ?? "/etc/samba/smb.conf";
    return (
        <HistoryPage id="smb-history-page" sources={[file]} admin={smb.admin} generation={smb.config.tag ?? ""}
                     current={() => smb.config.text}
                     restore={async (_source, text) => {
                         const result = await smb.saveText(text);
                         reportSave(smb, result);
                     }}
                     notices={<SmbNotices />} />
    );
};
