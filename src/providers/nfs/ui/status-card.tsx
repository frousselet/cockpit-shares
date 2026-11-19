/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * NFS server status: installation, kernel server, systemd units, firewall.
 */

import React, { useEffect, useState } from "react";
import cockpit from "cockpit";

import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { DropdownItem } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { Divider } from "@patternfly/react-core/dist/esm/components/Divider/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import { FirewalldRequest } from "cockpit-components-firewalld-request";
import { KebabDropdown } from "cockpit-components-dropdown";
import { install_dialog } from "cockpit-components-install-dialog";
import { getPackageManager } from "packagemanager";

import { useNfs } from "../state.tsx";
import { ServiceRow } from "../../../lib/services.tsx";
import { ErrorAlert } from "../../../lib/utils.tsx";
import { confBoolean } from "./options.ts";
import { NfsNotices } from "./common.tsx";

const _ = cockpit.gettext;

/** "-2 +3 +4 +4.1 +4.2" -> ["3", "4.0", "4.1", "4.2"] */
export function enabledVersions(kernel: string): string[] {
    return kernel.split(/\s+/).filter(v => v.startsWith("+"))
            .map(v => v.slice(1))
            .map(v => (v === "4" ? "4.0" : v));
}

export const NfsStatusCard = () => {
    const nfs = useNfs();
    const env = nfs.env;
    const [canInstall, setCanInstall] = useState<boolean | null>(null);

    useEffect(() => {
        if (env && !env.installed)
            getPackageManager().then(() => setCanInstall(true))
                    .catch(() => setCanInstall(false));
    }, [env]);

    if (nfs.envError)
        return <ErrorAlert error={{ message: _("Cannot inspect the NFS installation"), detail: nfs.envError }} />;
    if (!env)
        return null;

    if (!env.installed) {
        return (
            <Card isPlain className="ct-card" id="nfs-status">
                <CardHeader actions={{
                    actions: canInstall && nfs.admin
                        ? <Button variant="secondary" id="nfs-install" onClick={() => install_dialog(env.packageName).then(() => nfs.refreshEnvironment())
                                .catch(() => undefined)}>{_("Install the NFS server")}</Button>
                        : null,
                }}>
                    <CardTitle component="h2">{_("NFS server")}</CardTitle>
                </CardHeader>
                <CardBody className="shares-muted">
                    {canInstall === false
                        ? cockpit.format(_("Install the $0 package to share directories with Linux and UNIX computers."), env.packageName)
                        : _("The NFS server shares directories with Linux and UNIX computers. It is not installed.")}
                </CardBody>
            </Card>
        );
    }

    const conf = nfs.conf.get("nfsd");
    const v3 = confBoolean(conf?.get("vers3") ?? "y") !== false;
    const versions = env.kernelVersions ? enabledVersions(env.kernelVersions) : null;
    const actions = [
        <DropdownItem key="settings" onClick={() => cockpit.location.go(["nfs", "settings"])}>{_("Server settings")}</DropdownItem>,
        <DropdownItem key="history" onClick={() => cockpit.location.go(["nfs", "history"])}>{_("History of changes")}</DropdownItem>,
    ];
    const problems = nfs.files.flatMap(f => f.file.entries().flatMap(e => e.problems.map(p => `${e.entry.path}: ${p}`)));

    return (
        <>
            <NfsNotices />
            <FirewalldRequest service="nfs" title={_("The firewall does not allow NFS yet")} pageSection={false} />
            {v3 && <FirewalldRequest service="mountd" title={_("The firewall does not allow mountd (NFSv3) yet")} pageSection={false} />}
            {v3 && <FirewalldRequest service="rpc-bind" title={_("The firewall does not allow rpcbind (NFSv3) yet")} pageSection={false} />}
            <Card isPlain className="ct-card" id="nfs-status">
                <CardHeader actions={{
                    actions: (
                        <Flex>
                            <Button variant="secondary" id="nfs-settings-button" onClick={() => cockpit.location.go(["nfs", "settings"])}>
                                {_("Settings")}
                            </Button>
                            <KebabDropdown toggleButtonId="nfs-status-actions" dropdownItems={actions} />
                        </Flex>),
                }}>
                    <CardTitle component="h2">{_("NFS server")}</CardTitle>
                </CardHeader>
                <CardBody>
                    <Stack hasGutter>
                        {problems.length > 0 &&
                            <ErrorAlert error={{ message: _("Some export lines are ambiguous"), detail: problems.join("\n") }} />}
                        <DescriptionList isHorizontal isCompact columnModifier={{ default: "1Col" }} horizontalTermWidthModifier={{ default: "14rem", lg: "20rem" }}>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Version")}</DescriptionListTerm>
                                <DescriptionListDescription id="nfs-version">{env.version ? cockpit.format(_("nfs-utils $0"), env.version) : _("Unknown")}</DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Protocol versions")}</DescriptionListTerm>
                                <DescriptionListDescription id="nfs-versions">
                                    {versions
                                        ? <Flex spaceItems={{ default: "spaceItemsSm" }}>{versions.map(v => <FlexItem key={v}><Label isCompact>{"NFSv" + v}</Label></FlexItem>)}</Flex>
                                        : <span className="shares-muted">{_("The kernel NFS server is not running.")}</span>}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Configuration")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    <code>{nfs.files.map(f => f.path).join(", ")}</code>
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        </DescriptionList>
                        <Divider />
                        <DescriptionList isHorizontal isCompact columnModifier={{ default: "1Col" }} horizontalTermWidthModifier={{ default: "14rem", lg: "20rem" }} id="nfs-services">
                            {env.units.server &&
                                <ServiceRow unit={env.units.server} label={_("NFS server")} admin={nfs.admin}
                                            description={_("Kernel NFS server, mountd and the related services.")} />}
                            {env.units.rpcbind && v3 &&
                                <ServiceRow unit={env.units.rpcbind} label={_("RPC port mapper")} admin={nfs.admin}
                                            description={_("Needed by NFSv3 clients (rpcbind).")} />}
                            {!env.units.server &&
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Services")}</DescriptionListTerm>
                                    <DescriptionListDescription>{_("No NFS server systemd unit was found.")}</DescriptionListDescription>
                                </DescriptionListGroup>}
                        </DescriptionList>
                    </Stack>
                </CardBody>
            </Card>
        </>
    );
};
