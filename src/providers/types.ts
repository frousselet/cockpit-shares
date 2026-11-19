/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * A share provider implements one sharing protocol (SMB today, NFS or others
 * later). The overview page lists the shares of every provider in a single
 * table and shows the provider specific cards; everything below
 * "#/<provider id>/..." is rendered by the provider itself.
 */

import type React from "react";
import type { Dialogs } from "dialogs";

export interface ShareSummary {
    /** unique within the provider */
    id: string;
    name: string;
    path: string;
    description: string;
    enabled: boolean;
    access: "read-only" | "read-write" | "special";
    guest: boolean;
    /** short translated labels, e.g. "Home directories", "Hidden" */
    labels: string[];
    /** cockpit location path of the details page */
    location: string;
    /** defined outside the files this page manages (included file, registry) */
    external: boolean;
    /** number of clients currently connected, null when unknown */
    connections: number | null;
}

export interface ProviderShares {
    /** still loading */
    loading: boolean;
    /** the protocol server is installed */
    available: boolean;
    shares: ShareSummary[];
}

export interface ShareProvider {
    id: string;
    /** protocol name shown in tables, not translated (SMB, NFS) */
    label: string;
    /** translated description used in menus, e.g. "Windows and macOS (SMB)" */
    description: () => string;
    /** wraps the whole application and holds the provider state */
    Root: React.ComponentType<{ children: React.ReactNode }>;
    useShares: () => ProviderShares;
    /** status and configuration of the server, shown before the share list */
    StatusCard: React.ComponentType;
    /** additional cards shown after the share list (users, sessions, ...) */
    OverviewCards: React.ComponentType;
    /** kebab actions of a share row */
    ShareActions: React.ComponentType<{ share: ShareSummary }>;
    /** opens the dialog creating a share */
    createShare: (dialogs: Dialogs) => void;
    /** can a share be created right now */
    useCanCreate: () => boolean;
    /** renders "#/<id>/<path...>", null when unknown */
    renderPage: (path: string[]) => React.ReactNode | null;
}
