/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * React state of the NFS provider: environment, live exports files, active
 * exports, nfs.conf, saving.
 */

import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import cockpit from "cockpit";
import { superuser } from "superuser";
import { useEvent } from "hooks";

import { ExportsFile, parseExportfsVerbose, type ActiveExport } from "./exports.ts";
import {
    detectEnvironment, saveExports, activeExports, readNfsConf, writeNfsConf, EXPORTS_FILE, NFS_CONF,
    type NfsEnvironment, type NfsConf, type NfsDiagnostic,
} from "./backend.ts";

const _ = cockpit.gettext;

export interface ExportsFileState {
    path: string;
    loaded: boolean;
    exists: boolean;
    text: string;
    tag: string | null;
    file: ExportsFile;
    error: string | null;
}

export interface NfsNotice {
    id: number;
    variant: "success" | "info" | "warning" | "danger";
    title: string;
    detail?: string[];
    restart?: boolean;
}

/** Where an export lives: file and line index of the entry. */
export interface ExportRef {
    file: string;
    index: number;
}

export interface NfsState {
    env: NfsEnvironment | null;
    envError: string | null;
    files: ExportsFileState[];
    loaded: boolean;
    active: ActiveExport[];
    conf: NfsConf;
    admin: boolean;
    /** change one exports file: validated by exportfs, backed up, written and applied */
    updateExports: (file: string, mutate: (f: ExportsFile) => void) => Promise<NfsDiagnostic[]>;
    saveExportsText: (file: string, text: string) => Promise<NfsDiagnostic[]>;
    saveConf: (changes: { section: string, key: string, value: string | null }[]) => Promise<void>;
    refreshEnvironment: () => void;
    notices: NfsNotice[];
    notify: (n: Omit<NfsNotice, "id">) => void;
    dismiss: (id: number) => void;
    /** find an export by path and occurrence among all files */
    find: (path: string, occurrence?: number) => ExportRef | null;
}

const NfsContext = React.createContext<NfsState | null>(null);

export function useNfs(): NfsState {
    const ctx = useContext(NfsContext);
    if (!ctx)
        throw new Error("useNfs() outside of <NfsProvider>");
    return ctx;
}

let noticeId = 0;

const emptyFile = (path: string): ExportsFileState => ({
    path, loaded: false, exists: false, text: "", tag: null, file: ExportsFile.parse(""), error: null,
});

export const NfsProvider = ({ children }: { children: React.ReactNode }) => {
    useEvent(superuser, "changed");
    const allowed = superuser.allowed;
    const [env, setEnv] = useState<NfsEnvironment | null>(null);
    const [envError, setEnvError] = useState<string | null>(null);
    const [generation, setGeneration] = useState(0);
    const [files, setFiles] = useState<Record<string, ExportsFileState>>({});
    const [active, setActive] = useState<ActiveExport[]>([]);
    const [conf, setConf] = useState<NfsConf>(new Map());
    const [confGeneration, setConfGeneration] = useState(0);
    const [notices, setNotices] = useState<NfsNotice[]>([]);
    const filesRef = useRef(files);
    filesRef.current = files;

    useEffect(() => {
        detectEnvironment()
                .then(e => { setEnv(e); setEnvError(null) })
                .catch(ex => setEnvError(String(ex.detail || ex.message)));
    }, [generation, allowed]);

    const paths = useMemo(() => (env?.installed ? [EXPORTS_FILE, ...env.extraFiles] : []), [env]);

    // watch every exports file
    useEffect(() => {
        if (paths.length === 0)
            return;
        const handles = paths.map(path => {
            const handle = cockpit.file(path, { superuser: "try" });
            const watch = handle.watch((content, tag, error) => {
                setFiles(old => ({
                    ...old,
                    [path]: error
                        ? { ...(old[path] ?? emptyFile(path)), loaded: true, error: error.message ?? String(error) }
                        : {
                            path,
                            loaded: true,
                            exists: content !== null,
                            text: content ?? "",
                            tag: tag ?? "-",
                            file: ExportsFile.parse(content ?? ""),
                            error: null,
                        },
                }));
            });
            return { handle, watch };
        });
        return () => handles.forEach(({ handle, watch }) => { watch.remove(); handle.close() });
    }, [paths]);

    const texts = paths.map(p => files[p]?.text ?? "").join("\u0000");
    const loaded = paths.length > 0 && paths.every(p => files[p]?.loaded);

    // what exportfs exported, after every change of the files
    useEffect(() => {
        if (!env?.installed || !loaded)
            return;
        let cancelled = false;
        activeExports().then(out => { if (!cancelled) setActive(parseExportfsVerbose(out)); });
        return () => { cancelled = true };
    }, [env, loaded, texts]);

    // nfs.conf, watched for changes made elsewhere
    useEffect(() => {
        if (!env?.installed)
            return;
        const handle = cockpit.file(NFS_CONF, { superuser: "try" });
        const watch = handle.watch(() => setConfGeneration(g => g + 1), { read: false });
        return () => { watch.remove(); handle.close() };
    }, [env]);

    useEffect(() => {
        if (!env?.installed || !env.tools.nfsconf)
            return;
        readNfsConf().then(setConf);
    }, [env, confGeneration]);

    const notify = useCallback((n: Omit<NfsNotice, "id">) => {
        const id = ++noticeId;
        setNotices(list => [...list.filter(x => x.title !== n.title), { ...n, id }]);
    }, []);
    const dismiss = useCallback((id: number) => setNotices(list => list.filter(n => n.id !== id)), []);

    const saveExportsText = useCallback(async (path: string, text: string) => {
        if (!env)
            throw new Error("NFS is not available");
        const current = filesRef.current[path] ?? emptyFile(path);
        const result = await saveExports(env, path, text, current.exists ? current.tag : "-");
        setFiles(old => ({
            ...old,
            [path]: { path, loaded: true, exists: true, text, tag: result.tag, file: ExportsFile.parse(text), error: null },
        }));
        activeExports().then(out => setActive(parseExportfsVerbose(out)));
        const warnings = result.diagnostics.filter(d => d.level !== "info");
        if (warnings.length)
            notify({ variant: "warning", title: _("Saved with warnings from exportfs"), detail: warnings.map(d => d.message) });
        return result.diagnostics;
    }, [env, notify]);

    const updateExports = useCallback(async (path: string, mutate: (f: ExportsFile) => void) => {
        const copy = (filesRef.current[path] ?? emptyFile(path)).file.clone();
        mutate(copy);
        return saveExportsText(path, copy.toString());
    }, [saveExportsText]);

    const saveConf = useCallback(async (changes: { section: string, key: string, value: string | null }[]) => {
        await writeNfsConf(changes);
        setConf(await readNfsConf());
        if (changes.length)
            notify({ variant: "info", title: _("Restart the NFS server to apply the new settings"), restart: true });
    }, [notify]);

    const fileStates = paths.map(p => files[p] ?? emptyFile(p));

    const value = useMemo<NfsState>(() => ({
        env,
        envError,
        files: fileStates,
        loaded,
        active,
        conf,
        admin: allowed === true,
        updateExports,
        saveExportsText,
        saveConf,
        refreshEnvironment: () => setGeneration(g => g + 1),
        notices,
        notify,
        dismiss,
        find: (path: string, occurrence = 0) => {
            let n = 0;
            for (const f of fileStates) {
                for (const { index, entry } of f.file.entries()) {
                    if (entry.path !== path)
                        continue;
                    if (n === occurrence)
                        return { file: f.path, index };
                    n++;
                }
            }
            return null;
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [env, envError, files, loaded, active, conf, allowed, updateExports, saveExportsText, saveConf, notices, notify, dismiss]);

    return <NfsContext.Provider value={value}>{children}</NfsContext.Provider>;
};
