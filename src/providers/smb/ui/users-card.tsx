/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Samba accounts (passdb): list, add, password, enable, disable, delete.
 */

import React, { useCallback, useEffect, useState } from "react";
import cockpit from "cockpit";

import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { DropdownItem } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { Divider } from "@patternfly/react-core/dist/esm/components/Divider/index.js";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { Content } from "@patternfly/react-core/dist/esm/components/Content/index.js";

import { useDialogs } from "dialogs";
import { ListingTable } from "cockpit-components-table";
import { KebabDropdown } from "cockpit-components-dropdown";
import { FormHelper } from "cockpit-components-form-helper";

import { useSmb } from "../state.tsx";
import { listSambaUsers, addSambaUser, setSambaPassword, setSambaUserEnabled, deleteSambaUser } from "../backend.ts";
import type { SambaUser } from "../parsers.ts";
import { ErrorAlert, formatDate } from "../../../lib/utils.tsx";
import { DialogFrame, ConfirmDialog, useSubmit } from "./dialogs.tsx";
import { useAccounts } from "./accounts.ts";

const _ = cockpit.gettext;

const PasswordFields = ({ password, setPassword, confirm, setConfirm }: {
    password: string, setPassword: (v: string) => void, confirm: string, setConfirm: (v: string) => void,
}) => (
    <>
        <FormGroup label={_("Password")} fieldId="smb-user-password" isRequired>
            <TextInput id="smb-user-password" type="password" autoComplete="new-password" value={password}
                       onChange={(_ev, v) => setPassword(v)}
            />
        </FormGroup>
        <FormGroup label={_("Confirm")} fieldId="smb-user-confirm" isRequired>
            <TextInput id="smb-user-confirm" type="password" autoComplete="new-password" value={confirm}
                       validated={confirm && confirm !== password ? "error" : "default"}
                       onChange={(_ev, v) => setConfirm(v)}
            />
            <FormHelper fieldId="smb-user-confirm"
                        helperTextInvalid={confirm && confirm !== password ? _("The passwords do not match.") : undefined}
                        helperText={_("Samba keeps its own password, independent of the system password.")}
            />
        </FormGroup>
    </>
);

const AddUserDialog = ({ existing, onDone }: { existing: SambaUser[], onDone: () => void }) => {
    const accounts = useAccounts();
    const [name, setName] = useState("");
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const { error, busy, submit } = useSubmit();
    const candidates = (accounts?.regularUsers ?? []).filter(u => u.uid !== 0 && !existing.some(e => e.name === u.name));
    const valid = name !== "" && password !== "" && password === confirm;

    const onSubmit = () => submit(async () => {
        await addSambaUser(name, password);
        onDone();
    });

    return (
        <DialogFrame id="smb-add-user" title={_("Add Samba user")} error={error} isSubmitting={busy}
                     isDisabled={!valid} submitLabel={_("Add")} onSubmit={onSubmit} variant="small"
        >
            <Form onSubmit={ev => { ev.preventDefault(); if (valid) onSubmit(); }}>
                <Content component="p">
                    {_("A Samba user is a system account allowed to connect to shares.")}{" "}
                    <Button variant="link" isInline onClick={() => cockpit.jump("/users")}>{_("Create a system account")}</Button>
                </Content>
                <FormGroup label={_("System account")} fieldId="smb-user-name" isRequired>
                    <FormSelect id="smb-user-name" value={name} onChange={(_ev, v) => setName(v)}>
                        <FormSelectOption value="" label={accounts ? _("Choose an account") : _("Loading...")} isPlaceholder />
                        {candidates.map(u => <FormSelectOption key={u.name} value={u.name} label={u.gecos ? `${u.name} (${u.gecos})` : u.name} />)}
                    </FormSelect>
                </FormGroup>
                <PasswordFields password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
            </Form>
        </DialogFrame>
    );
};

const PasswordDialog = ({ user, onDone }: { user: string, onDone: () => void }) => {
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const { error, busy, submit } = useSubmit();
    const valid = password !== "" && password === confirm;
    const onSubmit = () => submit(async () => { await setSambaPassword(user, password); onDone() });
    return (
        <DialogFrame id="smb-user-passwd" title={cockpit.format(_("Samba password of $0"), user)} error={error}
                     isSubmitting={busy} isDisabled={!valid} submitLabel={_("Set password")} onSubmit={onSubmit} variant="small"
        >
            <Form onSubmit={ev => { ev.preventDefault(); if (valid) onSubmit(); }}>
                <PasswordFields password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
            </Form>
        </DialogFrame>
    );
};

export const SmbUsersCard = () => {
    const smb = useSmb();
    const Dialogs = useDialogs();
    const [users, setUsers] = useState<SambaUser[] | null>(null);
    const [error, setError] = useState<unknown>(null);

    const refresh = useCallback(() => {
        listSambaUsers().then(u => { setUsers(u); setError(null) })
                .catch(ex => { setError(ex); setUsers([]) });
    }, []);

    useEffect(() => {
        if (smb.env?.installed && smb.admin)
            refresh();
    }, [smb.env, smb.admin, refresh]);

    if (!smb.env?.installed)
        return null;

    const backend = smb.inherited("passdb backend") ?? "tdbsam";

    if (!smb.admin) {
        return (
            <Card isPlain className="ct-card" id="smb-users">
                <CardHeader><CardTitle component="h2">{_("Samba users")}</CardTitle></CardHeader>
                <CardBody>{_("Administrative access is required to list Samba users.")}</CardBody>
            </Card>
        );
    }

    const act = (f: () => Promise<void>) => f().then(refresh)
            .catch(setError);

    const rows = (users ?? []).map(u => {
        const actions = [
            <DropdownItem key="pw" onClick={() => Dialogs.show(<PasswordDialog user={u.name} onDone={refresh} />)}>{_("Set password")}</DropdownItem>,
            <DropdownItem key="toggle" onClick={() => act(() => setSambaUserEnabled(u.name, u.disabled))}>
                {u.disabled ? _("Enable") : _("Disable")}
            </DropdownItem>,
            <Divider key="sep" component="li" />,
            <DropdownItem key="delete" className="pf-m-danger" onClick={() => Dialogs.show(
                <ConfirmDialog id="smb-user-delete" title={cockpit.format(_("Remove Samba user $0?"), u.name)}
                               body={_("The account can no longer connect to shares. The system account is kept.")}
                               confirmLabel={_("Remove")}
                               onConfirm={async () => { await deleteSambaUser(u.name); refresh() }}
                />)}
            >
                {_("Remove")}
            </DropdownItem>,
        ];
        return {
            props: { key: u.name, "data-user": u.name },
            columns: [
                { title: <Button variant="link" isInline onClick={() => cockpit.jump("/users#/" + u.name)}>{u.name}</Button>, sortKey: u.name },
                u.fullName,
                {
                    title: (
                        <>
                            {u.disabled ? <Label color="orange" isCompact>{_("Disabled")}</Label> : <Label color="green" isCompact>{_("Enabled")}</Label>}
                            {u.locked && <Label color="red" isCompact>{_("Locked")}</Label>}
                            {u.passwordNotRequired && <Label isCompact>{_("No password")}</Label>}
                        </>),
                },
                formatDate(u.passwordLastSet),
                { title: <KebabDropdown toggleButtonId={"smb-user-actions-" + u.name} dropdownItems={actions} />, props: { className: "pf-v6-c-table__action" } },
            ],
        };
    });

    return (
        <Card isPlain className="ct-card" id="smb-users">
            <CardHeader actions={{
                actions: (
                    <Button variant="secondary" id="smb-add-user-button" isDisabled={users === null}
                            onClick={() => Dialogs.show(<AddUserDialog existing={users ?? []} onDone={refresh} />)}
                    >
                        {_("Add user")}
                    </Button>),
            }}
            >
                <CardTitle component="h2">{_("Samba users")}</CardTitle>
            </CardHeader>
            {!!error && <CardBody><ErrorAlert error={error} /></CardBody>}
            <ListingTable aria-label={_("Samba users")} variant="compact" id="smb-users-list"
                          columns={[
                              { title: _("Account"), sortable: true },
                              _("Full name"),
                              _("Status"),
                              _("Password changed"),
                              { title: "", props: { screenReaderText: _("Actions") } },
                          ]}
                          rows={rows}
                          loading={users === null ? _("Loading...") : ""}
                          emptyCaption={_("No Samba user")}
                          emptyCaptionDetail={cockpit.format(_("Add system accounts to the Samba account database ($0) so that they can connect."), backend)}
            />
        </Card>
    );
};
