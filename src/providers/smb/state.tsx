/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * React state of the SMB provider: environment detection, live smb.conf,
 * effective values computed by testparm, built-in defaults and saving.
 */

import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import cockpit from "cockpit";
import { superuser } from "superuser";
import { useEvent } from "hooks";

import { SmbConf } from "./smbconf.ts";
import { catalogResolver } from "./catalog.ts";
import {
    detectEnvironment, testparm, builtinDefaults, saveConfig, type SmbEnvironment, type TestparmResult, type SaveResult,
} from "./backend.ts";

export interface SmbConfigState {
    loaded: boolean;
    exists: boolean;
    text: string;
    tag: string | null;
    conf: SmbConf;
    error: string | null;
}

export interface Notice {
    id: number;
    variant: "success" | "info" | "warning" | "danger";
    title: string;
    detail?: string[];
    /** offer to restart the file server */
    restart?: boolean;
}

export interface SmbState {
    env: SmbEnvironment | null;
    envError: string | null;
    config: SmbConfigState;
    /** testparm -v of the file on disk; [global] holds the value every share inherits */
    effective: TestparmResult | null;
    /** testparm -v of an empty configuration */
    defaults: Map<string, string> | null;
    admin: boolean;
    /** apply a modification to a copy of the current configuration, validate, save and reload */
    update: (mutate: (conf: SmbConf) => void) => Promise<SaveResult>;
    /** replace the whole file */
    saveText: (text: string) => Promise<SaveResult>;
    refreshEnvironment: () => void;
    /** value a share gets when it does not set a parameter */
    inherited: (name: string) => string | undefined;
    /** value [global] gets when it does not set a parameter */
    builtin: (name: string) => string | undefined;
    notices: Notice[];
    notify: (notice: Omit<Notice, "id">) => void;
    dismiss: (id: number) => void;
}

let noticeId = 0;

const SmbContext = React.createContext<SmbState | null>(null);

export function useSmb(): SmbState {
    const ctx = useContext(SmbContext);
    if (!ctx)
        throw new Error("useSmb() outside of <SmbProvider>");
    return ctx;
}

const emptyConfig: SmbConfigState = {
    loaded: false, exists: false, text: "", tag: null, conf: SmbConf.parse("", catalogResolver), error: null,
};

export const SmbProvider = ({ children }: { children: React.ReactNode }) => {
    useEvent(superuser, "changed");
    const [env, setEnv] = useState<SmbEnvironment | null>(null);
    const [envError, setEnvError] = useState<string | null>(null);
    const [envGeneration, setEnvGeneration] = useState(0);
    const [config, setConfig] = useState<SmbConfigState>(emptyConfig);
    const [effective, setEffective] = useState<TestparmResult | null>(null);
    const [defaults, setDefaults] = useState<Map<string, string> | null>(null);
    const [notices, setNotices] = useState<Notice[]>([]);
    const notify = useCallback((n: Omit<Notice, "id">) => {
        const id = ++noticeId;
        // keep the latest notice of each kind only
        setNotices(list => [...list.filter(x => x.title !== n.title), { ...n, id }]);
    }, []);
    const dismiss = useCallback((id: number) => setNotices(list => list.filter(n => n.id !== id)), []);
    const configRef = useRef(config);
    configRef.current = config;

    // tools in sbin can only be found once administrative access is granted
    const allowed = superuser.allowed;
    useEffect(() => {
        detectEnvironment()
                .then(e => { setEnv(e); setEnvError(null) })
                .catch(ex => setEnvError(String(ex.detail || ex.message)));
    }, [envGeneration, allowed]);

    // watch the configuration file
    useEffect(() => {
        if (!env?.installed)
            return;
        const handle = cockpit.file(env.configFile, { superuser: "try", max_read_size: 16 * 1024 * 1024 });
        const watch = handle.watch((content, tag, error) => {
            if (error) {
                setConfig(c => ({ ...c, loaded: true, error: error.message ?? String(error) }));
                return;
            }
            const text = content ?? "";
            setConfig({
                loaded: true,
                exists: content !== null,
                text,
                tag: tag ?? "-",
                conf: SmbConf.parse(text, catalogResolver),
                error: null,
            });
        });
        return () => {
            watch.remove();
            handle.close();
        };
    }, [env]);

    // effective configuration, recomputed whenever the file changes
    useEffect(() => {
        if (!env?.installed || !config.loaded)
            return;
        let cancelled = false;
        testparm({ file: env.configFile, verbose: true })
                .then(r => { if (!cancelled) setEffective(r); })
                .catch(ex => {
                    if (!cancelled)
                        setEffective({ ok: false, diagnostics: [{ level: "error", message: String(ex.detail || ex.message) }], dump: null });
                });
        return () => { cancelled = true };
    }, [env, config.loaded, config.text]);

    useEffect(() => {
        if (!env?.installed)
            return;
        builtinDefaults().then(setDefaults)
                .catch(ex => console.warn("Cannot read Samba defaults:", ex));
    }, [env]);

    const saveText = useCallback(async (text: string) => {
        if (!env)
            throw new Error("Samba is not available");
        const current = configRef.current;
        const result = await saveConfig(env, text, current.exists ? current.tag : "-");
        // the watch callback updates the state as well; do it now to avoid flicker
        setConfig({ loaded: true, exists: true, text, tag: result.tag, conf: SmbConf.parse(text, catalogResolver), error: null });
        return result;
    }, [env]);

    const update = useCallback(async (mutate: (conf: SmbConf) => void) => {
        const copy = configRef.current.conf.clone();
        mutate(copy);
        return saveText(copy.toString());
    }, [saveText]);

    const effectiveGlobal = effective?.dump?.section("global")?.parameters;

    const value = useMemo<SmbState>(() => ({
        env,
        envError,
        config,
        effective,
        defaults,
        admin: superuser.allowed === true,
        update,
        saveText,
        refreshEnvironment: () => setEnvGeneration(g => g + 1),
        inherited: (name: string) => effectiveGlobal?.get(catalogResolver(name).name)?.value ?? defaults?.get(catalogResolver(name).name),
        builtin: (name: string) => defaults?.get(catalogResolver(name).name),
        notices,
        notify,
        dismiss,
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [env, envError, config, effective, defaults, update, saveText, effectiveGlobal, superuser.allowed, notices, notify, dismiss]);

    return <SmbContext.Provider value={value}>{children}</SmbContext.Provider>;
};
