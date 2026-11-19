/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * System users and groups, used to suggest names in user and group lists.
 */

import { useEffect, useState } from "react";

import { readPasswdAndGroups, readLoginDefs } from "../backend.ts";
import { parsePasswd, parseGroup, type PasswdEntry, type GroupEntry } from "../parsers.ts";

export interface Accounts {
    users: PasswdEntry[];
    groups: GroupEntry[];
    /** regular (human) accounts according to /etc/login.defs */
    regularUsers: PasswdEntry[];
}

let cache: Promise<Accounts> | null = null;

export function loadAccounts(force = false): Promise<Accounts> {
    if (!cache || force) {
        cache = Promise.all([readPasswdAndGroups(), readLoginDefs()]).then(([{ passwd, group }, defs]) => {
            const users = parsePasswd(passwd);
            const nologin = /(nologin|\/false)$/;
            return {
                users,
                groups: parseGroup(group),
                regularUsers: users.filter(u => (u.uid >= defs.uidMin && u.uid <= defs.uidMax && !nologin.test(u.shell)) || u.uid === 0),
            };
        });
        cache.catch(() => { cache = null });
    }
    return cache;
}

export function useAccounts(): Accounts | null {
    const [accounts, setAccounts] = useState<Accounts | null>(null);
    useEffect(() => {
        let cancelled = false;
        loadAccounts().then(a => { if (!cancelled) setAccounts(a); })
                .catch(ex => console.warn("Cannot read accounts:", ex));
        return () => { cancelled = true };
    }, []);
    return accounts;
}
