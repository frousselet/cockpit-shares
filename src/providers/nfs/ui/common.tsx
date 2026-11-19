/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React, { useState } from "react";
import cockpit from "cockpit";

import { Alert, AlertActionCloseButton, AlertActionLink } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";

import { useNfs, type NfsState } from "../state.tsx";
import { resolveOptions, effectiveOptions, optionName, optionValue, type ExportEntry, type ClientItem } from "../exports.ts";
import { tryRestartUnit } from "../../../lib/services.tsx";
import { ErrorAlert } from "../../../lib/utils.tsx";

const _ = cockpit.gettext;

export function exportLocation(path: string, occurrence = 0): string {
    return "/nfs/export/" + encodeURIComponent(path) + (occurrence > 0 ? "?n=" + occurrence : "");
}

export function hostLabel(host: string): string {
    return host === "*" || host === "" ? _("Everyone") : host;
}

export function clients(entry: ExportEntry): { item: ClientItem, index: number, options: string[] }[] {
    return entry.items.flatMap((item, index) => item.kind === "client"
        ? [{ item, index, options: resolveOptions(effectiveOptions(entry, index)) }]
        : []);
}

export function isReadWrite(options: string[]): boolean {
    let rw = false;
    for (const o of options) {
        if (o === "rw")
            rw = true;
        else if (o === "ro")
            rw = false;
    }
    return rw;
}

export function securityFlavors(options: string[]): string[] {
    const sec = options.filter(o => optionName(o) === "sec").map(o => optionValue(o) ?? "");
    return sec.length ? sec.join(":").split(":") : ["sys"];
}

export const NfsNotices = () => {
    const nfs = useNfs();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<unknown>(null);
    if (nfs.notices.length === 0 && !error)
        return null;
    return (
        <Flex direction={{ default: "column" }} className="shares-notices">
            {!!error && <ErrorAlert error={error} title={_("Restarting the NFS server failed")} />}
            {nfs.notices.map(n => (
                <Alert key={n.id} variant={n.variant} isInline title={n.title}
                       actionClose={<AlertActionCloseButton onClose={() => nfs.dismiss(n.id)} />}
                       actionLinks={n.restart && nfs.admin && nfs.env?.units.server
                           ? <AlertActionLink isDisabled={busy} onClick={() => {
                               setBusy(true);
                               setError(null);
                               tryRestartUnit(nfs.env!.units.server!)
                                       .then(() => nfs.dismiss(n.id))
                                       .catch(setError)
                                       .finally(() => setBusy(false));
                           }}>{_("Restart now")}</AlertActionLink>
                           : undefined}>
                    {n.detail && n.detail.map((d, i) => <p key={i}>{d}</p>)}
                </Alert>))}
        </Flex>
    );
};

/** Report an error that happened outside of a dialog. */
export function reportError(nfs: NfsState, ex: unknown) {
    const e = ex as { message?: string, detail?: string, diagnostics?: { message: string }[] };
    nfs.notify({
        variant: "danger",
        title: e.message ?? String(ex),
        detail: e.diagnostics?.map(d => d.message) ?? (e.detail ? [e.detail] : []),
    });
}
