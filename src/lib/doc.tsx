/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Renders the upstream Samba documentation stored in the catalog. The HTML is
 * generated at build time from the Samba sources by
 * tools/generate-smb-catalog.py, which only emits a small set of tags.
 */

import React from "react";
import cockpit from "cockpit";

const _ = cockpit.gettext;

export const SambaDoc = ({ html, onReference, className = "" }: {
    html: string,
    onReference?: (name: string) => void,
    className?: string,
}) => {
    if (!html)
        return <p className="shares-doc-missing">{_("No documentation available.")}</p>;

    const onClick = (ev: React.MouseEvent) => {
        const target = (ev.target as HTMLElement).closest("[data-param]");
        if (target && onReference) {
            ev.preventDefault();
            onReference(target.getAttribute("data-param")!);
        }
    };

    return (
        <div className={"shares-doc " + (onReference ? "shares-doc-linked " : "") + className}
             lang="en"
             onClick={onClick}
             // the catalog only contains markup generated from the Samba sources
             // eslint-disable-next-line react/no-danger
             dangerouslySetInnerHTML={{ __html: html }}
        />
    );
};
