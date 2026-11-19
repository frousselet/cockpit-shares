/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React, { useState } from "react";
import cockpit from "cockpit";

import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { LabelGroup } from "@patternfly/react-core/dist/esm/components/Label/LabelGroup.js";
import { Page, PageSection } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { SearchInput } from "@patternfly/react-core/dist/esm/components/SearchInput/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";
import { Toolbar, ToolbarContent, ToolbarItem } from "@patternfly/react-core/dist/esm/components/Toolbar/index.js";
import { Dropdown, DropdownItem, DropdownList } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { MenuToggle } from "@patternfly/react-core/dist/esm/components/MenuToggle/index.js";
import { SearchIcon } from "@patternfly/react-icons";

import { usePageLocation } from "hooks";
import { WithDialogs, useDialogs } from "dialogs";
import { EmptyStatePanel } from "cockpit-components-empty-state";
import { ListingTable } from "cockpit-components-table";

import { PROVIDERS } from "./providers/index.ts";
import type { ShareProvider, ShareSummary } from "./providers/types.ts";

const _ = cockpit.gettext;

const ProvidersRoot = ({ children }: { children: React.ReactNode }) =>
    PROVIDERS.reduceRight<React.ReactNode>((inner, provider) => <provider.Root>{inner}</provider.Root>, children) as React.ReactElement;

const CreateShareButton = () => {
    const Dialogs = useDialogs();
    const [isOpen, setIsOpen] = useState(false);
    const usable: ShareProvider[] = [];
    for (const p of PROVIDERS) {
        // eslint-disable-next-line react-hooks/rules-of-hooks
        if (p.useCanCreate())
            usable.push(p);
    }

    if (usable.length <= 1) {
        return (
            <Button id="create-share" variant="secondary" isDisabled={usable.length === 0}
                    onClick={() => usable[0].createShare(Dialogs)}
            >
                {_("Create share")}
            </Button>
        );
    }

    return (
        <Dropdown isOpen={isOpen} onOpenChange={setIsOpen} popperProps={{ position: "end" }}
                  toggle={ref => <MenuToggle ref={ref} id="create-share" variant="secondary" onClick={() => setIsOpen(!isOpen)}>{_("Create share")}</MenuToggle>}
        >
            <DropdownList>
                {usable.map(p => (
                    <DropdownItem key={p.id} onClick={() => { setIsOpen(false); p.createShare(Dialogs) }}>
                        {p.description()}
                    </DropdownItem>))}
            </DropdownList>
        </Dropdown>
    );
};

const ShareList = () => {
    const [filter, setFilter] = useState("");
    const lists = PROVIDERS.map(p => ({ provider: p, ...p.useShares() }));
    const loading = lists.some(l => l.loading);
    const available = lists.filter(l => l.available);

    if (!loading && available.length === 0)
        return null;

    const matches = (s: ShareSummary) => {
        const f = filter.toLowerCase();
        return !f || s.name.toLowerCase().includes(f) || s.path.toLowerCase().includes(f) || s.description.toLowerCase().includes(f);
    };

    const rows = lists.flatMap(({ provider, shares }) => shares.filter(matches).map(share => {
        const status = [];
        if (!share.enabled)
            status.push(<Label key="disabled" color="orange" isCompact>{_("Disabled")}</Label>);
        if (share.access === "read-only")
            status.push(<Label key="ro" isCompact>{_("Read only")}</Label>);
        if (share.guest)
            status.push(<Label key="guest" color="blue" isCompact>{_("Guest access")}</Label>);
        if (share.external)
            status.push(<Label key="ext" color="purple" isCompact>{_("Defined elsewhere")}</Label>);
        for (const l of share.labels)
            status.push(<Label key={l} isCompact variant="outline">{l}</Label>);
        return {
            props: { key: provider.id + "/" + share.id, "data-share": share.name },
            columns: [
                {
                    title: <Button variant="link" isInline onClick={() => cockpit.location.go(share.location)}>{share.name}</Button>,
                    sortKey: share.name.toLowerCase(),
                },
                { title: <Label isCompact color="grey">{provider.label}</Label>, sortKey: provider.label },
                { title: share.path || "-", sortKey: share.path },
                { title: share.description, sortKey: share.description },
                { title: <LabelGroup numLabels={4}>{status}</LabelGroup> },
                {
                    title: share.connections === null ? "" : String(share.connections),
                    sortKey: String(share.connections ?? 0).padStart(6, "0"),
                },
                { title: <provider.ShareActions share={share} />, props: { className: "pf-v6-c-table__action" } },
            ],
        };
    }));

    const total = lists.reduce((n, l) => n + l.shares.length, 0);

    return (
        <Card isPlain className="ct-card" id="shares">
            <CardHeader actions={{
                actions: (
                    <Toolbar>
                        <ToolbarContent>
                            {total > 0 &&
                                <ToolbarItem>
                                    <SearchInput id="shares-filter" placeholder={_("Filter by name or path")} value={filter}
                                                 onChange={(_ev, v) => setFilter(v)} onClear={() => setFilter("")}
                                    />
                                </ToolbarItem>}
                            <ToolbarItem>
                                <CreateShareButton />
                            </ToolbarItem>
                        </ToolbarContent>
                    </Toolbar>
                ),
                hasNoOffset: false,
            }}
            >
                <CardTitle component="h2">{_("Shares")}</CardTitle>
            </CardHeader>
            <ListingTable id="shares-list" aria-label={_("Shares")} variant="compact" gridBreakPoint="grid-lg"
                          columns={[
                              { title: _("Name"), sortable: true, props: { modifier: "fitContent" } },
                              { title: _("Protocol"), sortable: true, props: { modifier: "fitContent" } },
                              { title: _("Path"), sortable: true },
                              { title: _("Description"), sortable: true },
                              { title: _("Status") },
                              { title: _("Connections"), sortable: true, props: { modifier: "fitContent" } },
                              { title: "", props: { screenReaderText: _("Actions") } },
                          ]}
                          rows={rows}
                          loading={loading ? _("Loading...") : ""}
                          isEmptyStateInTable={filter !== "" && total > 0}
                          emptyCaption={_("No shares")}
                          emptyCaptionDetail={_("Create a share to make a directory available on the network.")}
                          emptyComponent={filter !== "" && total > 0
                              ? <EmptyStatePanel title={_("No matching shares")} icon={SearchIcon}
                                                 action={_("Clear filter")} actionVariant="link" onAction={() => setFilter("")}
                              />
                              : undefined}
                          sortBy={{ index: 0, direction: "asc" as never }}
            />
        </Card>
    );
};

const Overview = () => (
    <Page id="shares-overview" className="pf-m-no-sidebar">
        <PageSection hasBodyWrapper={false}>
            <Stack hasGutter>
                {PROVIDERS.map(p => <p.StatusCard key={p.id} />)}
                <ShareList />
                {PROVIDERS.map(p => <p.OverviewCards key={p.id} />)}
            </Stack>
        </PageSection>
    </Page>
);

const NotFound = () => (
    <Page className="pf-m-no-sidebar">
        <PageSection hasBodyWrapper={false}>
            <EmptyStatePanel title={_("Page not found")}
                             action={_("Back to file sharing")} actionVariant="link"
                             onAction={() => cockpit.location.go("/")}
            />
        </PageSection>
    </Page>
);

const Router = () => {
    const { path } = usePageLocation();
    let content: React.ReactNode = null;

    if (path.length === 0) {
        content = <Overview />;
    } else {
        const provider = PROVIDERS.find(p => p.id === path[0]);
        content = provider?.renderPage(path.slice(1)) ?? <NotFound />;
    }

    // a separate dialog host per page: dialogs close when navigating away
    return <WithDialogs key={path.join("/")}>{content}</WithDialogs>;
};

export const Application = () => (
    <ProvidersRoot>
        <Router />
    </ProvidersRoot>
);
