/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React from "react";
import cockpit from "cockpit";

import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { List, ListItem } from "@patternfly/react-core/dist/esm/components/List/index.js";

const _ = cockpit.gettext;

export interface Problem {
    level: "error" | "warning" | "info";
    message: string;
}

/** Human readable text of anything thrown by the backend. */
export function errorMessage(ex: unknown): { title: string, detail: string } {
    if (ex && typeof ex === "object") {
        const e = ex as { message?: string, detail?: string, problem?: string };
        return { title: e.message ?? String(ex), detail: e.detail ?? "" };
    }
    return { title: String(ex), detail: "" };
}

/** Error details shown inside dialogs and cards. */
export const ErrorAlert = ({ error, title, isInline = true }: { error: unknown, title?: string, isInline?: boolean }) => {
    if (!error)
        return null;
    const { title: message, detail } = errorMessage(error);
    const diagnostics = (error as { diagnostics?: Problem[] }).diagnostics;
    return (
        <Alert variant="danger" isInline={isInline} title={title ?? message} className="shares-error">
            {title && message !== title && <p>{message}</p>}
            {detail && <pre className="shares-error-detail">{detail}</pre>}
            {diagnostics && <DiagnosticsList diagnostics={diagnostics} />}
        </Alert>
    );
};

export const DiagnosticsList = ({ diagnostics }: { diagnostics: Problem[] }) => {
    if (diagnostics.length === 0)
        return null;
    return (
        <List isPlain className="shares-diagnostics">
            {diagnostics.map((d, i) => (
                <ListItem key={i} className={"shares-diagnostic-" + d.level}>
                    <code>{d.message}</code>
                </ListItem>))}
        </List>
    );
};

/** Join a list of names for display: "alice, bob and carol" */
export function formatList(items: string[]): string {
    if (items.length <= 1)
        return items.join("");
    return cockpit.format(_("$0 and $1"), items.slice(0, -1).join(", "), items[items.length - 1]);
}

export function formatDate(d: Date | number | null): string {
    if (d === null)
        return _("Never");
    const date = typeof d === "number" ? new Date(d * 1000) : d;
    return date.toLocaleString(cockpit.language.replace("_", "-"), { dateStyle: "medium", timeStyle: "short" });
}
