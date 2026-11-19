/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * systemd units of the file servers: state, start and enable, restart.
 */

import React, { useEffect, useState } from "react";
import cockpit from "cockpit";

import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";

import { proxy as serviceProxy } from "service";
import { useEvent, useObject } from "hooks";

import { ErrorAlert } from "./utils.tsx";

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

export const ServiceRow = ({ unit, label, description, admin }: { unit: string, label: string, description: string, admin: boolean }) => {
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

/** Restart a unit when it runs; nothing happens when it is stopped. */
export async function tryRestartUnit(unit: string): Promise<void> {
    const svc = serviceProxy(unit) as unknown as ServiceProxy;
    await new Promise<void>(resolve => svc.wait(resolve));
    await svc.tryRestart();
}
