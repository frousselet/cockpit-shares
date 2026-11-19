/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * [global] settings of Samba.
 */

import React from "react";
import cockpit from "cockpit";

import { Breadcrumb, BreadcrumbItem } from "@patternfly/react-core/dist/esm/components/Breadcrumb/index.js";
import { Page, PageBreadcrumb, PageSection } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import { EmptyStatePanel } from "cockpit-components-empty-state";

import { useSmb } from "../state.tsx";
import { GLOBAL_IDENTITY, GLOBAL_SECURITY, GLOBAL_NETWORK, GLOBAL_LOGGING, GLOBAL_SHARING } from "./labels.ts";
import { FieldGroupCard, customizedCount } from "./share-page.tsx";
import { SectionTabs } from "./tabs.tsx";
import { splitList } from "../smbconf.ts";
import { ParameterTable } from "./param-table.tsx";
import { VfsCard } from "./vfs-card.tsx";
import { SmbNotices } from "./status-card.tsx";

const _ = cockpit.gettext;

export const SmbGlobalPage = () => {
    const smb = useSmb();
    return (
        <Page id="smb-global-page" className="pf-m-no-sidebar">
            <PageBreadcrumb hasBodyWrapper={false} stickyOnBreakpoint={{ default: "top" }}>
                <Breadcrumb>
                    <BreadcrumbItem to="#/">{_("File sharing")}</BreadcrumbItem>
                    <BreadcrumbItem isActive>{_("SMB global settings")}</BreadcrumbItem>
                </Breadcrumb>
            </PageBreadcrumb>
            <PageSection hasBodyWrapper={false}>
                {!smb.env || !smb.config.loaded
                    ? <EmptyStatePanel loading />
                    : (
                        <Stack hasGutter>
                            <SmbNotices />
                            <SectionTabs id="smb-global-tabs" tabs={[
                                ...[GLOBAL_IDENTITY, GLOBAL_SECURITY, GLOBAL_NETWORK, GLOBAL_LOGGING, GLOBAL_SHARING].map(group => ({
                                    key: group.id,
                                    title: group.title(),
                                    count: customizedCount(smb, "global", group),
                                    content: <FieldGroupCard section="global" group={group} id={"smb-global-" + group.id} />,
                                })),
                                { key: "vfs", title: _("VFS modules"), count: splitList(smb.config.conf.get("global", "vfs objects") ?? "").length, content: <VfsCard section="global" /> },
                                { key: "parameters", title: _("All parameters"), count: smb.config.conf.section("global")?.parameters.size, content: <ParameterTable section="global" /> },
                            ]} />
                        </Stack>)}
            </PageSection>
        </Page>
    );
};
