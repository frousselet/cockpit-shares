/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * [global] settings of Samba.
 */

import React from "react";
import cockpit from "cockpit";

import { Breadcrumb, BreadcrumbItem } from "@patternfly/react-core/dist/esm/components/Breadcrumb/index.js";
import { Page, PageBreadcrumb, PageSection } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { Gallery } from "@patternfly/react-core/dist/esm/layouts/Gallery/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import { EmptyStatePanel } from "cockpit-components-empty-state";

import { useSmb } from "../state.tsx";
import { GLOBAL_IDENTITY, GLOBAL_SECURITY, GLOBAL_NETWORK, GLOBAL_LOGGING, GLOBAL_SHARING } from "./labels.ts";
import { FieldGroupCard } from "./share-page.tsx";
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
                            <Gallery hasGutter className="ct-cards-grid shares-cards">
                                <FieldGroupCard section="global" group={GLOBAL_IDENTITY} id="smb-global-identity" />
                                <FieldGroupCard section="global" group={GLOBAL_SECURITY} id="smb-global-security" />
                                <FieldGroupCard section="global" group={GLOBAL_NETWORK} id="smb-global-network" />
                                <FieldGroupCard section="global" group={GLOBAL_LOGGING} id="smb-global-logging" />
                                <FieldGroupCard section="global" group={GLOBAL_SHARING} id="smb-global-sharing" />
                            </Gallery>
                            <VfsCard section="global" />
                            <ParameterTable section="global" title={_("All global parameters")} />
                        </Stack>)}
            </PageSection>
        </Page>
    );
};
