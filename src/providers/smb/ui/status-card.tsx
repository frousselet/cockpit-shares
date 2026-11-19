/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Samba server status: installation, systemd units, identity, firewall,
 * configuration problems reported by testparm.
 */

import React, { useEffect, useState } from "react";
import cockpit from "cockpit";

import { Alert, AlertActionCloseButton, AlertActionLink } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { DropdownItem } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { Divider } from "@patternfly/react-core/dist/esm/components/Divider/index.js";
import { ExpandableSection } from "@patternfly/react-core/dist/esm/components/ExpandableSection/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import { proxy as serviceProxy } from "service";
import { useEvent, useObject } from "hooks";
import { EmptyStatePanel } from "cockpit-components-empty-state";
import { FirewalldRequest } from "cockpit-components-firewalld-request";
import { KebabDropdown } from "cockpit-components-dropdown";
import { install_dialog } from "cockpit-components-install-dialog";
import { getPackageManager } from "packagemanager";

import { useSmb, type SmbState } from "../state.tsx";
import { DiagnosticsList, ErrorAlert } from "../../../lib/utils.tsx";

const _ = cockpit.gettext;

interface ServiceProxy {
    exists: boolean | null,
    state: string | null | undefined,
    enabled: boolean | null | undefined,
    start: () => Promise<void>,
    stop: () => Promise<void>,
    restart: () => Promise<void>,
    tryRestart: () => Promise<void>,
    enable: () => Promise<void>,
    disable: () => Promise<void>,
    wait: (callback: () => void) => void,
    addEventListener: (event: string, handler: () => void) => void,
    removeEventListener: (event: string, handler: () => void) => void,
}

export function useService(name: string | null): ServiceProxy | null {
    const svc = useObject(() => (name ? serviceProxy(name) as unknown as ServiceProxy : null), null, [name]);
    useEvent(svc as never, "changed");
    return svc;
}

function stateLabel(svc: ServiceProxy | null) {
    if (!svc || svc.exists === null)
        return <Spinner size="sm" aria-label={_("Loading")} />;
    switch (svc.state) {
    case "running": return <Label color="green" isCompact>{_("Running")}</Label>;
    case "starting": return <Label color="blue" isCompact>{_("Starting")}</Label>;
    case "stopping": return <Label color="blue" isCompact>{_("Stopping")}</Label>;
    case "failed": return <Label color="red" isCompact>{_("Failed to start")}</Label>;
    case "stopped": return <Label isCompact>{_("Not running")}</Label>;
    default: return <Label isCompact>{_("Unknown")}</Label>;
    }
}

const ServiceRow = ({ unit, label, description, admin }: { unit: string, label: string, description: string, admin: boolean }) => {
    const svc = useService(unit);
    const [timedOut, setTimedOut] = useState(false);
    useEffect(() => {
        const timer = window.setTimeout(() => setTimedOut(true), 5000);
        return () => window.clearTimeout(timer);
    }, []);
    const [error, setError] = useState<unknown>(null);
    const [busy, setBusy] = useState(false);
    const active = svc?.state === "running" || svc?.state === "starting";

    const toggle = async (on: boolean) => {
        if (!svc)
            return;
        setBusy(true);
        setError(null);
        try {
            if (on) {
                await svc.enable();
                await svc.start();
            } else {
                await svc.disable();
                await svc.stop();
            }
        } catch (ex) {
            setError(ex);
        } finally {
            setBusy(false);
        }
    };

    return (
        <DescriptionListGroup>
            <DescriptionListTerm>{label}</DescriptionListTerm>
            <DescriptionListDescription>
                <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsMd" }}>
                    <FlexItem>
                        <Switch id={"service-switch-" + unit} isChecked={active && svc?.enabled === true}
                                isDisabled={!admin || busy || !svc?.exists}
                                aria-label={cockpit.format(_("Start and enable $0"), unit)}
                                onChange={(_ev, on) => toggle(on)}
                        />
                    </FlexItem>
                    <FlexItem>{svc?.exists === null && timedOut ? <Label isCompact>{_("Status unavailable")}</Label> : stateLabel(svc)}</FlexItem>
                    <FlexItem>
                        {svc?.enabled === false && active && <Label isCompact variant="outline">{_("Not started at boot")}</Label>}
                        {svc?.enabled === true && !active && <Label isCompact variant="outline">{_("Started at boot")}</Label>}
                    </FlexItem>
                    <FlexItem>
                        <Button variant="link" isInline onClick={() => cockpit.jump("/system/services#/" + unit + ".service")}>
                            {cockpit.format(_("$0 service"), unit)}
                        </Button>
                    </FlexItem>
                </Flex>
                <div className="shares-service-description">{description}</div>
                {!!error && <ErrorAlert error={error} />}
            </DescriptionListDescription>
        </DescriptionListGroup>
    );
};

async function restartServer(smb: SmbState) {
    const units = [smb.env?.units.smbd, smb.env?.units.nmbd, smb.env?.units.winbind].filter(Boolean) as string[];
    for (const u of units) {
        const svc = serviceProxy(u) as unknown as ServiceProxy;
        await new Promise<void>(resolve => svc.wait(resolve));
        await svc.tryRestart();
    }
}

export const SmbNotices = () => {
    const smb = useSmb();
    const [restarting, setRestarting] = useState(false);
    const [error, setError] = useState<unknown>(null);
    if (smb.notices.length === 0 && !error)
        return null;
    return (
        <Flex direction={{ default: "column" }} className="shares-notices">
            {!!error && <ErrorAlert error={error} title={_("Restarting the file server failed")} />}
            {smb.notices.map(n => (
                <Alert key={n.id} variant={n.variant} isInline title={n.title}
                       actionClose={<AlertActionCloseButton onClose={() => smb.dismiss(n.id)} />}
                       actionLinks={n.restart && smb.admin
                           ? <AlertActionLink isDisabled={restarting} onClick={() => {
                               setRestarting(true);
                               setError(null);
                               restartServer(smb)
                                       .then(() => smb.dismiss(n.id))
                                       .catch(setError)
                                       .finally(() => setRestarting(false));
                           }}
                           >{_("Restart now")}
                           </AlertActionLink>
                           : undefined}
                >
                    {n.detail && n.detail.map((d, i) => <p key={i}>{d}</p>)}
                </Alert>))}
        </Flex>
    );
};

const NotInstalled = () => {
    const smb = useSmb();
    const [canInstall, setCanInstall] = useState<boolean | null>(null);
    useEffect(() => {
        getPackageManager().then(() => setCanInstall(true))
                .catch(() => setCanInstall(false));
    }, []);
    return (
        <EmptyStatePanel title={_("Samba is not installed")}
                         paragraph={canInstall === false
                             ? _("Install the samba package to share directories with Windows, macOS and Linux computers.")
                             : _("Samba shares directories with Windows, macOS and Linux computers.")}
                         action={canInstall && smb.admin ? _("Install Samba") : undefined}
                         onAction={() => {
                             install_dialog("samba")
                                     .then(() => smb.refreshEnvironment())
                                     .catch(() => undefined);
                         }}
        />
    );
};

export const SmbStatusCard = () => {
    const smb = useSmb();
    const env = smb.env;

    if (smb.envError)
        return <ErrorAlert error={{ message: _("Cannot inspect the Samba installation"), detail: smb.envError }} />;

    if (!env) {
        return (
            <Card isPlain className="ct-card">
                <CardBody><EmptyStatePanel loading title={_("Loading")} headingLevel="h2" /></CardBody>
            </Card>
        );
    }

    if (!env.installed) {
        return (
            <Card isPlain className="ct-card" id="smb-status">
                <CardHeader><CardTitle component="h2">{_("SMB file server")}</CardTitle></CardHeader>
                <CardBody><NotInstalled /></CardBody>
            </Card>
        );
    }

    const global = smb.effective?.dump?.section("global")?.parameters;
    const value = (n: string) => global?.get(n)?.value ?? smb.builtin(n) ?? "";
    const role = value("server role").toLowerCase();
    const diagnostics = smb.effective?.diagnostics.filter(d => d.level !== "info") ?? [];
    const errors = diagnostics.filter(d => d.level === "error");

    const actions = [
        <DropdownItem key="settings" onClick={() => cockpit.location.go(["smb", "settings"])}>{_("Global settings")}</DropdownItem>,
        <DropdownItem key="history" onClick={() => cockpit.location.go(["smb", "history"])}>{_("History of changes")}</DropdownItem>,
    ];

    return (
        <>
            <SmbNotices />
            <FirewalldRequest service="samba" title={_("The firewall does not allow Samba yet")} pageSection={false} />
            <Card isPlain className="ct-card" id="smb-status">
                <CardHeader actions={{
                    actions: (
                        <Flex>
                            <Button variant="secondary" id="smb-settings-button" onClick={() => cockpit.location.go(["smb", "settings"])}>
                                {_("Settings")}
                            </Button>
                            <KebabDropdown toggleButtonId="smb-status-actions" dropdownItems={actions} />
                        </Flex>),
                }}
                >
                    <CardTitle component="h2">{_("SMB file server")}</CardTitle>
                </CardHeader>
                <CardBody>
                    <Stack hasGutter>
                        {smb.config.error && <ErrorAlert error={{ message: _("Cannot read the configuration file"), detail: smb.config.error }} />}
                        {smb.config.loaded && !smb.config.exists &&
                            <Alert variant="info" isInline title={cockpit.format(_("$0 does not exist yet"), env.configFile)}>
                                {_("It is created with the first change made on this page.")}
                            </Alert>}
                        {(role.includes("active directory") || role === "dc" || role.includes("domain controller") || (env.units.addc && !env.units.smbd)) &&
                            <Alert variant="warning" isInline title={_("This server is an Active Directory domain controller")}>
                                {_("File shares can be managed here; domain settings are managed with samba-tool.")}
                            </Alert>}
                        {diagnostics.length > 0 &&
                            <Alert variant={errors.length ? "danger" : "warning"} isInline
                                   title={errors.length ? _("Samba cannot load the configuration") : cockpit.format(cockpit.ngettext("testparm reports $0 warning", "testparm reports $0 warnings", diagnostics.length), diagnostics.length)}
                            >
                                <ExpandableSection toggleTextCollapsed={_("Show details")} toggleTextExpanded={_("Hide details")}>
                                    <DiagnosticsList diagnostics={diagnostics} />
                                </ExpandableSection>
                            </Alert>}
                        <DescriptionList isHorizontal isCompact columnModifier={{ default: "1Col" }}>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Version")}</DescriptionListTerm>
                                <DescriptionListDescription id="smb-version">{env.versionString || _("Unknown")}</DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Server name")}</DescriptionListTerm>
                                <DescriptionListDescription id="smb-netbios-name">
                                    {value("netbios name") || <Spinner size="sm" />}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Workgroup")}</DescriptionListTerm>
                                <DescriptionListDescription id="smb-workgroup">{value("workgroup")}</DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Role")}</DescriptionListTerm>
                                <DescriptionListDescription>{value("server role")}</DescriptionListDescription>
                            </DescriptionListGroup>
                        </DescriptionList>
                        <Divider />
                        <DescriptionList isHorizontal isCompact columnModifier={{ default: "1Col" }} id="smb-services">
                            {env.units.smbd &&
                                <ServiceRow unit={env.units.smbd} label={_("File server")} admin={smb.admin}
                                            description={_("Serves the shares (smbd).")}
                                />}
                            {env.units.nmbd &&
                                <ServiceRow unit={env.units.nmbd} label={_("NetBIOS name service")} admin={smb.admin}
                                            description={_("Makes the server visible to older clients (nmbd).")}
                                />}
                            {env.units.winbind &&
                                <ServiceRow unit={env.units.winbind} label={_("Domain accounts")} admin={smb.admin}
                                            description={_("Resolves users and groups of a Windows domain (winbindd).")}
                                />}
                            {env.units.wsdd &&
                                <ServiceRow unit={env.units.wsdd} label={_("Network discovery")} admin={smb.admin}
                                            description={_("Shows the server in the Network folder of Windows 10 and later (WS-Discovery).")}
                                />}
                            {!env.units.smbd && !env.units.addc &&
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Services")}</DescriptionListTerm>
                                    <DescriptionListDescription>{_("No Samba systemd unit was found.")}</DescriptionListDescription>
                                </DescriptionListGroup>}
                        </DescriptionList>
                    </Stack>
                </CardBody>
            </Card>
        </>
    );
};
