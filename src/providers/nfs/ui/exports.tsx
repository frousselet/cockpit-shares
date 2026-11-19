/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * NFS exports: summaries for the overview, row actions, creation, removal
 * and change of path.
 */

import React, { useEffect, useState } from "react";
import cockpit from "cockpit";

import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import { Divider } from "@patternfly/react-core/dist/esm/components/Divider/index.js";
import { DropdownItem } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { ExpandableSection } from "@patternfly/react-core/dist/esm/components/ExpandableSection/index.js";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { Radio } from "@patternfly/react-core/dist/esm/components/Radio/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";

import { useDialogs, type Dialogs } from "dialogs";
import { KebabDropdown } from "cockpit-components-dropdown";
import { FormHelper } from "cockpit-components-form-helper";
import { FileAutoComplete } from "cockpit-components-file-autocomplete";

import { useNfs, type NfsState } from "../state.tsx";
import { serializeEntry, hostProblem, type ExportEntry } from "../exports.ts";
import { EXPORTS_FILE, pathExists } from "../backend.ts";
import { createDirectory } from "../../../lib/system.ts";
import type { ShareSummary } from "../../types.ts";
import { DialogFrame, ConfirmDialog, TextPromptDialog, useSubmit } from "../../smb/ui/dialogs.tsx";
import { exportLocation, clients, isReadWrite, securityFlavors, hostLabel } from "./common.tsx";
import { HostInput } from "./client-dialog.tsx";

const _ = cockpit.gettext;

export function summarize(nfs: NfsState): ShareSummary[] {
    const result: ShareSummary[] = [];
    const seen = new Map<string, number>();
    for (const f of nfs.files) {
        for (const { entry } of f.file.entries()) {
            const occurrence = seen.get(entry.path) ?? 0;
            seen.set(entry.path, occurrence + 1);
            const list = clients(entry);
            const rw = list.some(c => isReadWrite(c.options));
            const labels: string[] = [];
            if (list.some(c => c.options.some(o => o === "fsid=0" || o === "fsid=root")))
                labels.push(_("NFSv4 root"));
            if (list.some(c => securityFlavors(c.options).some(s => s.startsWith("krb5"))))
                labels.push(_("Kerberos"));
            if (nfs.loaded && !nfs.active.some(a => a.path === entry.path))
                labels.push(_("Not exported"));
            result.push({
                id: `${entry.path}#${occurrence}`,
                name: entry.path,
                path: "",
                description: list.map(c => `${hostLabel(c.item.host)} (${isReadWrite(c.options) ? _("read and write") : _("read only")})`).join(", "),
                enabled: true,
                access: rw ? "read-write" : "read-only",
                guest: list.some(c => c.item.host === "*" || c.item.host === ""),
                labels,
                location: exportLocation(entry.path, occurrence),
                external: false,
                connections: null,
            });
        }
    }
    return result;
}

export function deleteExport(Dialogs: Dialogs, nfs: NfsState, path: string, occurrence: number, goBack: boolean) {
    Dialogs.show(
        <ConfirmDialog id="nfs-delete-export" title={cockpit.format(_("Stop exporting $0?"), path)}
                       body={_("The line is removed from the exports and clients lose access. The directory and its files are kept.")}
                       confirmLabel={_("Delete")}
                       onConfirm={async () => {
                           const ref = nfs.find(path, occurrence);
                           if (!ref)
                               return;
                           await nfs.updateExports(ref.file, f => f.remove(ref.index));
                           if (goBack)
                               cockpit.location.go("/");
                       }} />);
}

export function changePath(Dialogs: Dialogs, nfs: NfsState, path: string, occurrence: number) {
    Dialogs.show(
        <TextPromptDialog id="nfs-change-path" title={cockpit.format(_("Change the path of $0"), path)} label={_("New path")}
                          initial={path} submitLabel={_("Change")}
                          help={_("Clients that mounted the old path need to mount the new one.")}
                          validate={v => {
                              if (!v.startsWith("/"))
                                  return _("Enter an absolute path.");
                              if (v === path)
                                  return _("Enter a different path.");
                              return null;
                          }}
                          onSubmit={async v => {
                              const ref = nfs.find(path, occurrence);
                              if (!ref)
                                  return;
                              const entry = nfs.files.find(f => f.path === ref.file)!.file.lines[ref.index].entry!;
                              await nfs.updateExports(ref.file, f => f.replace(ref.index, { ...entry, path: v }));
                              cockpit.location.go(exportLocation(v, 0));
                          }} />);
}

export const ExportActions = ({ share }: { share: ShareSummary }) => {
    const nfs = useNfs();
    const Dialogs = useDialogs();
    if (!nfs.admin)
        return null;
    const [path, occ] = [share.name, Number(share.id.split("#").pop())];
    const items = [
        <DropdownItem key="edit" onClick={() => cockpit.location.go(share.location)}>{_("Edit")}</DropdownItem>,
        <DropdownItem key="path" onClick={() => changePath(Dialogs, nfs, path, occ)}>{_("Change path")}</DropdownItem>,
        <Divider key="sep" component="li" />,
        <DropdownItem key="delete" className="pf-m-danger" onClick={() => deleteExport(Dialogs, nfs, path, occ, false)}>{_("Delete")}</DropdownItem>,
    ];
    return <KebabDropdown toggleButtonId={"export-actions-" + path.replace(/\W+/g, "-")} dropdownItems={items} />;
};

type Mapping = "default" | "root" | "all";

export function creationOptions(access: "rw" | "ro", mapping: Mapping, insecure: boolean): string[] {
    const options: string[] = [access, "sync", "no_subtree_check"];
    if (mapping === "root")
        options.push("no_root_squash");
    if (mapping === "all")
        options.push("all_squash");
    if (insecure)
        options.push("insecure");
    return options;
}

export const CreateExportDialog = () => {
    const nfs = useNfs();
    const { error, busy, submit } = useSubmit();
    const [path, setPath] = useState("");
    const [exists, setExists] = useState<boolean | null>(null);
    const [createDir, setCreateDir] = useState(true);
    const [host, setHost] = useState("*");
    const [access, setAccess] = useState<"rw" | "ro">("rw");
    const [mapping, setMapping] = useState<Mapping>("default");
    const [insecure, setInsecure] = useState(false);

    useEffect(() => {
        if (!path.startsWith("/")) {
            setExists(null);
            return;
        }
        let cancelled = false;
        const timer = window.setTimeout(() => pathExists(path).then(e => { if (!cancelled) setExists(e); }), 300);
        return () => { cancelled = true; window.clearTimeout(timer) };
    }, [path]);

    const pathProblem = path && !path.startsWith("/") ? _("Enter an absolute path.") : null;
    const already = nfs.find(path) !== null;
    const hostIssue = hostProblem(host);
    const entry: ExportEntry = {
        path,
        items: [{ kind: "client", host: host.trim(), options: creationOptions(access, mapping, insecure) }],
        comment: "",
    };
    const canSubmit = path !== "" && !pathProblem && !hostIssue;

    const onSubmit = () => submit(async () => {
        if (exists === false && createDir)
            await createDirectory(path, "root", "root", "0755");
        await nfs.updateExports(EXPORTS_FILE, f => f.add(entry));
        cockpit.location.go(exportLocation(path, already ? 1 : 0));
    });

    return (
        <DialogFrame id="nfs-create-export" title={_("Create NFS export")} error={error} isSubmitting={busy}
                     isDisabled={!canSubmit} submitLabel={_("Create")} onSubmit={onSubmit}>
            <Form isHorizontal onSubmit={ev => { ev.preventDefault(); if (canSubmit) onSubmit(); }}>
                <FormGroup label={_("Directory")} fieldId="nfs-create-path" isRequired>
                    <FileAutoComplete id="nfs-create-path" value={path} onlyDirectories isOptionCreatable superuser="try"
                                      placeholder={_("/srv/nfs")} onChange={(v: string) => setPath(v)} />
                    <FormHelper fieldId="nfs-create-path" helperTextInvalid={pathProblem ?? undefined}
                                helperText={already
                                    ? _("This directory is already exported; a second line is added.")
                                    : (exists === false ? _("This directory does not exist yet.") : undefined)} />
                </FormGroup>
                {exists === false &&
                    <FormGroup fieldId="nfs-create-mkdir" label={_("New directory")}>
                        <Checkbox id="nfs-create-mkdir" isChecked={createDir} onChange={(_ev, c) => setCreateDir(c)}
                                  label={_("Create the directory (owner root, permissions 755)")} />
                    </FormGroup>}
                <FormGroup label={_("Client")} fieldId="nfs-create-host" isRequired>
                    <HostInput id="nfs-create-host" value={host} onChange={setHost} />
                    <FormHelper fieldId="nfs-create-host" helperText={_("* lets every host connect. Add more clients on the export page.")} />
                </FormGroup>
                <FormGroup label={_("Access")} fieldId="nfs-create-access" role="radiogroup" isInline>
                    <Radio id="nfs-create-rw" name="nfs-access" label={_("Read and write")} isChecked={access === "rw"} onChange={() => setAccess("rw")} />
                    <Radio id="nfs-create-ro" name="nfs-access" label={_("Read only")} isChecked={access === "ro"} onChange={() => setAccess("ro")} />
                </FormGroup>
                <FormGroup label={_("User mapping")} fieldId="nfs-create-mapping" role="radiogroup" isStack>
                    <Radio id="nfs-create-map-default" name="nfs-mapping" isChecked={mapping === "default"} onChange={() => setMapping("default")}
                           label={_("Keep user identities")} description={_("Root of the client uses the anonymous account (root_squash).")} />
                    <Radio id="nfs-create-map-root" name="nfs-mapping" isChecked={mapping === "root"} onChange={() => setMapping("root")}
                           label={_("Trust root of the client")} description={_("For diskless clients or backups (no_root_squash).")} />
                    <Radio id="nfs-create-map-all" name="nfs-mapping" isChecked={mapping === "all"} onChange={() => setMapping("all")}
                           label={_("Everyone uses the anonymous account")} description={_("For a public directory (all_squash).")} />
                </FormGroup>
                <FormGroup fieldId="nfs-create-insecure" label={_("Client ports")}>
                    <Checkbox id="nfs-create-insecure" isChecked={insecure} onChange={(_ev, c) => setInsecure(c)}
                              label={_("Accept any port (needed by macOS)")} />
                </FormGroup>
            </Form>
            <Divider className="shares-dialog-divider" />
            <ExpandableSection toggleText={_("Line added to /etc/exports")} id="nfs-create-preview">
                <Flex>
                    <pre className="shares-preview">{path ? serializeEntry(entry) : "…"}</pre>
                </Flex>
            </ExpandableSection>
        </DialogFrame>
    );
};

/** Text prompt used by the export page to add a comment to a line. */
export const CommentDialog = ({ file, index, entry }: { file: string, index: number, entry: ExportEntry }) => {
    const nfs = useNfs();
    const { error, busy, submit } = useSubmit();
    const [text, setText] = useState(entry.comment.replace(/^#\s?/, ""));
    return (
        <DialogFrame id="nfs-comment" title={_("Description")} error={error} isSubmitting={busy} variant="small"
                     onSubmit={() => submit(() => nfs.updateExports(file, f => f.replace(index, { ...entry, comment: text.trim() ? "# " + text.trim() : "" })).then(() => undefined))}>
            <Form onSubmit={ev => ev.preventDefault()}>
                <FormGroup label={_("Description")} fieldId="nfs-comment-text">
                    <TextInput id="nfs-comment-text" value={text} onChange={(_ev, v) => setText(v.replace(/[\r\n]/g, " "))} />
                    <FormHelper fieldId="nfs-comment-text" helperText={_("Written as a comment at the end of the line.")} />
                </FormGroup>
            </Form>
        </DialogFrame>
    );
};
