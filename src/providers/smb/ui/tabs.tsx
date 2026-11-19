/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Tabs whose selection is kept in the page location ("?tab=..."), so that
 * the browser history and reloads keep the current section.
 */

import React from "react";
import cockpit from "cockpit";

import { Badge } from "@patternfly/react-core/dist/esm/components/Badge/index.js";
import { Tab, Tabs, TabTitleText } from "@patternfly/react-core/dist/esm/components/Tabs/index.js";

import { usePageLocation } from "hooks";

export interface SectionTab {
    key: string;
    title: string;
    /** number shown next to the title, hidden when 0 or undefined */
    count?: number | undefined;
    content: React.ReactNode;
}

export const SectionTabs = ({ id, tabs }: { id: string, tabs: SectionTab[] }) => {
    const { path, options } = usePageLocation();
    const requested = typeof options.tab === "string" ? options.tab : "";
    const active = tabs.some(t => t.key === requested) ? requested : tabs[0].key;

    return (
        <Tabs id={id} className="shares-tabs" activeKey={active} mountOnEnter unmountOnExit
              aria-label={cockpit.gettext("Sections")}
              onSelect={(_ev, key) => cockpit.location.go(path, { ...options, tab: String(key) })}>
            {tabs.map(t => (
                <Tab key={t.key} eventKey={t.key} id={`${id}-${t.key}`}
                     title={
                         <TabTitleText>
                             {t.title}
                             {!!t.count && <Badge isRead className="shares-tab-count">{t.count}</Badge>}
                         </TabTitleText>
                     }>
                    <div className="shares-tab-content">{t.content}</div>
                </Tab>))}
        </Tabs>
    );
};
