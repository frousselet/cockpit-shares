/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Export options of exports(5) (nfs-utils 2.6) and the server settings of
 * nfs.conf(5), with translated labels.
 */

import cockpit from "cockpit";

import { optionName, optionValue } from "../exports.ts";

const _ = cockpit.gettext;

export type OptionGroup = "access" | "mapping" | "security" | "advanced";

export function groupLabel(group: OptionGroup): string {
    switch (group) {
    case "access": return _("Access");
    case "mapping": return _("User mapping");
    case "security": return _("Security");
    case "advanced": return _("Advanced");
    }
}

/** Exclusive flags: one of the values applies, the first one is the default. */
export interface ChoiceOption {
    kind: "choice";
    id: string;
    group: OptionGroup;
    label: () => string;
    help: () => string;
    values: { token: string, aliases?: string[], label: () => string }[];
    /** written even when it is the default, as recommended by exports(5) */
    explicit?: boolean;
}

/** Option with a value, "name=value". */
export interface ValueOption {
    kind: "value";
    id: string;
    group: OptionGroup;
    label: () => string;
    help: () => string;
    /** check of the value, returns a translated problem */
    validate?: (value: string) => string | null;
    placeholder?: string;
    /** accepted values offered in a list */
    choices?: { value: string, label: () => string }[];
    /** colon separated list of choices, e.g. sec=krb5p:sys */
    multiple?: boolean;
}

/** Flag without opposite, e.g. "nordirplus". */
export interface FlagOption {
    kind: "flag";
    id: string;
    group: OptionGroup;
    label: () => string;
    help: () => string;
}

export type ExportOption = ChoiceOption | ValueOption | FlagOption;

const isUid = (v: string) => (/^\d+$/.test(v) && Number(v) < 4294967295 ? null : _("Enter a number."));

export const EXPORT_OPTIONS: ExportOption[] = [
    {
        kind: "choice",
        id: "access",
        group: "access",
        label: () => _("Access"),
        help: () => _("Read only is the default."),
        values: [{ token: "ro", label: () => _("Read only") }, { token: "rw", label: () => _("Read and write") }],
        explicit: true,
    },
    {
        kind: "choice",
        id: "sync",
        group: "access",
        label: () => _("Writes"),
        help: () => _("Asynchronous writes are faster, but a crash of the server can lose or corrupt data."),
        values: [{ token: "sync", label: () => _("Synchronous") }, { token: "async", label: () => _("Asynchronous") }],
        explicit: true,
    },
    {
        kind: "choice",
        id: "wdelay",
        group: "access",
        label: () => _("Group related writes"),
        help: () => _("The server delays a write slightly when another one is expected. Turn it off for many small unrelated writes."),
        values: [{ token: "wdelay", label: () => _("Yes") }, { token: "no_wdelay", label: () => _("No") }],
    },
    {
        kind: "choice",
        id: "subtree",
        group: "access",
        label: () => _("Subtree check"),
        help: () => _("Checks that each file is inside the exported directory. Useful for read only subdirectories of a file system; causes problems with renamed files."),
        values: [{ token: "no_subtree_check", label: () => _("No") }, { token: "subtree_check", label: () => _("Yes") }],
        explicit: true,
    },
    {
        kind: "choice",
        id: "root_squash",
        group: "mapping",
        label: () => _("Root of the client"),
        help: () => _("By default, requests of root on the client use the anonymous account."),
        values: [
            { token: "root_squash", label: () => _("Mapped to the anonymous account") },
            { token: "no_root_squash", label: () => _("Has root rights") },
        ],
    },
    {
        kind: "choice",
        id: "all_squash",
        group: "mapping",
        label: () => _("Other users of the client"),
        help: () => _("Map every user to the anonymous account, for example for a public directory."),
        values: [
            { token: "no_all_squash", label: () => _("Keep their identity") },
            { token: "all_squash", label: () => _("Mapped to the anonymous account") },
        ],
    },
    {
        kind: "value",
        id: "anonuid",
        group: "mapping",
        label: () => _("Anonymous user ID"),
        help: () => _("User ID of the anonymous account, 65534 by default."),
        placeholder: "65534",
        validate: isUid,
    },
    {
        kind: "value",
        id: "anongid",
        group: "mapping",
        label: () => _("Anonymous group ID"),
        help: () => _("Group ID of the anonymous account, 65534 by default."),
        placeholder: "65534",
        validate: isUid,
    },
    {
        kind: "value",
        id: "sec",
        group: "security",
        label: () => _("Authentication flavors"),
        help: () => _("sys trusts the user IDs sent by the client; krb5 uses Kerberos, krb5i adds integrity checks and krb5p encryption. Preferred flavors come first."),
        // strongest first: the order of sec= is the order of preference
        choices: [
            { value: "krb5p", label: () => "krb5p" },
            { value: "krb5i", label: () => "krb5i" },
            { value: "krb5", label: () => "krb5" },
            { value: "sys", label: () => "sys" },
        ],
        multiple: true,
    },
    {
        kind: "value",
        id: "xprtsec",
        group: "security",
        label: () => _("Transport security (TLS)"),
        help: () => _("Restricts access to clients using RPC with TLS. Needs tlshd on the server."),
        choices: [
            { value: "none", label: () => _("none") },
            { value: "tls", label: () => "tls" },
            { value: "mtls", label: () => "mtls" },
        ],
        multiple: true,
    },
    {
        kind: "choice",
        id: "secure",
        group: "security",
        label: () => _("Client ports"),
        help: () => _("By default, requests must come from a port below 1024. Some clients, such as macOS, need insecure."),
        values: [
            { token: "secure", label: () => _("Below 1024 only (secure)") },
            { token: "insecure", label: () => _("Any port (insecure)") },
        ],
    },
    {
        kind: "choice",
        id: "locks",
        group: "security",
        label: () => _("Lock requests"),
        help: () => _("Old clients send locks without credentials; turn the check off if files can only be locked when everybody can read them."),
        values: [
            { token: "secure_locks", aliases: ["auth_nlm"], label: () => _("Authenticated") },
            { token: "insecure_locks", aliases: ["no_auth_nlm"], label: () => _("Not authenticated") },
        ],
    },
    {
        kind: "choice",
        id: "crossmnt",
        group: "advanced",
        label: () => _("File systems mounted below"),
        help: () => _("With crossmnt, clients also see the file systems mounted inside this directory."),
        values: [
            { token: "nocrossmnt", label: () => _("Not exported") },
            { token: "crossmnt", label: () => _("Exported with the same options (crossmnt)") },
        ],
    },
    {
        kind: "choice",
        id: "hide",
        group: "advanced",
        label: () => _("Visibility inside the parent export (NFSv3)"),
        help: () => _("nohide shows this file system to NFSv3 clients that mounted its parent. NFSv4 always shows it."),
        values: [{ token: "hide", label: () => _("Hidden") }, { token: "nohide", label: () => _("Visible (nohide)") }],
    },
    {
        kind: "value",
        id: "fsid",
        group: "advanced",
        label: () => _("File system ID"),
        help: () => _("Needed for file systems without UUID or device. root or 0 marks the root of the NFSv4 tree."),
        placeholder: "root, 0, 1, UUID",
        validate: v => (/^(root|\d+|[0-9a-fA-F:-]{32,})$/.test(v) ? null : _("Enter root, a number or a UUID.")),
    },
    {
        kind: "value",
        id: "mountpoint",
        group: "advanced",
        label: () => _("Export only when mounted"),
        help: () => _("With an empty value the directory must be a mount point; with a path, that path must be a mount point. Prevents exporting an empty directory when a disk failed to mount."),
        placeholder: _("this directory"),
    },
    {
        kind: "choice",
        id: "pnfs",
        group: "advanced",
        label: () => _("pNFS"),
        help: () => _("Lets NFSv4.1 clients access the storage directly when the file system supports it."),
        values: [{ token: "no_pnfs", label: () => _("No") }, { token: "pnfs", label: () => _("Yes") }],
    },
    {
        kind: "flag",
        id: "security_label",
        group: "advanced",
        label: () => _("Security labels (NFSv4.2)"),
        help: () => _("Clients can read and set SELinux labels. Every client needs the same policy."),
    },
    {
        kind: "flag",
        id: "nordirplus",
        group: "advanced",
        label: () => _("Disable READDIRPLUS (NFSv3)"),
        help: () => _("NFSv3 clients fall back to READDIR."),
    },
    {
        kind: "value",
        id: "refer",
        group: "advanced",
        label: () => _("Referral"),
        help: () => _("Sends clients to another location: path@host[+host][:path@host...]."),
        placeholder: "/path@server",
    },
    {
        kind: "value",
        id: "replicas",
        group: "advanced",
        label: () => _("Replicas"),
        help: () => _("Alternative locations given to clients that ask: path@host[+host][:path@host...]."),
        placeholder: "/path@server",
    },
    {
        kind: "value",
        id: "reexport",
        group: "advanced",
        label: () => _("Re-export of an NFS mount"),
        help: () => _("Assigns file system IDs to NFS mounts exported again. Needs Linux 5.19."),
        choices: [
            { value: "auto-fsidnum", label: () => "auto-fsidnum" },
            { value: "predefined-fsidnum", label: () => "predefined-fsidnum" },
        ],
    },
];

const MOUNTPOINT_NAMES = ["mountpoint", "mp"];

function tokensOf(opt: ExportOption): string[] {
    if (opt.kind === "choice")
        return opt.values.flatMap(v => [v.token, ...(v.aliases ?? [])]);
    if (opt.id === "mountpoint")
        return MOUNTPOINT_NAMES;
    return [opt.id];
}

function owns(opt: ExportOption, token: string): boolean {
    return tokensOf(opt).includes(optionName(token));
}

export function isKnownOption(token: string): boolean {
    return EXPORT_OPTIONS.some(o => owns(o, token)) || ["acl", "no_acl"].includes(optionName(token));
}

/**
 * Current value of an option in a list (the last occurrence wins).
 * Choices: the canonical token, null when not written (the default applies).
 * Values: the value, "" for "mountpoint" without value, null when not written.
 * Flags: "1" or null.
 */
export function readOption(options: string[], opt: ExportOption): string | null {
    let result: string | null = null;
    for (const token of options) {
        if (!owns(opt, token))
            continue;
        if (opt.kind === "choice")
            result = opt.values.find(v => v.token === token || (v.aliases ?? []).includes(token))!.token;
        else if (opt.kind === "flag")
            result = "1";
        else
            result = optionValue(token) ?? "";
    }
    return result;
}

/** Write an option into a list, in place of its earlier occurrences; null removes it. */
export function writeOption(options: string[], opt: ExportOption, value: string | null): string[] {
    const index = options.findIndex(t => owns(opt, t));
    const rest = options.filter(t => !owns(opt, t));
    if (value === null)
        return rest;
    let token: string;
    if (opt.kind === "choice" || opt.kind === "flag")
        token = opt.kind === "flag" ? opt.id : value;
    else if (opt.id === "mountpoint")
        token = value === "" ? "mountpoint" : `mountpoint=${value}`;
    else
        token = `${opt.id}=${value}`;
    const at = index < 0 ? rest.length : Math.min(index, rest.length);
    return [...rest.slice(0, at), token, ...rest.slice(at)];
}

/** Options not described by the catalog, kept as they are. */
export function otherOptions(options: string[]): string[] {
    return options.filter(t => !EXPORT_OPTIONS.some(o => owns(o, t)));
}

export function choiceLabel(opt: ChoiceOption, token: string | null): string {
    const v = opt.values.find(x => x.token === (token ?? opt.values[0].token));
    return v ? v.label() : token ?? "";
}

/* === nfs.conf ===================================================== */

export interface ConfSetting {
    section: string;
    key: string;
    type: "boolean" | "integer" | "string";
    default: string;
    label: () => string;
    help?: (() => string) | undefined;
    /** applied by restarting the NFS server */
    restart?: boolean;
}

const b = (section: string, key: string, dflt: string, label: () => string, help?: () => string): ConfSetting =>
    ({ section, key, type: "boolean", default: dflt, label, help, restart: true });
const n = (section: string, key: string, dflt: string, label: () => string, help?: () => string): ConfSetting =>
    ({ section, key, type: "integer", default: dflt, label, help, restart: true });
const s = (section: string, key: string, dflt: string, label: () => string, help?: () => string): ConfSetting =>
    ({ section, key, type: "string", default: dflt, label, help, restart: true });

/** Server side settings of nfs.conf, with the defaults written in the file shipped by nfs-utils. */
export const CONF_SETTINGS: ConfSetting[] = [
    n("nfsd", "threads", "8", () => _("Server threads"), () => _("Number of kernel threads serving requests. Raise it for many clients.")),
    b("nfsd", "vers3", "y", () => _("NFSv3")),
    b("nfsd", "vers4", "y", () => _("NFSv4")),
    b("nfsd", "vers4.0", "y", () => _("NFSv4.0")),
    b("nfsd", "vers4.1", "y", () => _("NFSv4.1")),
    b("nfsd", "vers4.2", "y", () => _("NFSv4.2")),
    b("nfsd", "tcp", "y", () => _("TCP")),
    b("nfsd", "udp", "n", () => _("UDP"), () => _("Only NFSv3 can use UDP.")),
    s("nfsd", "host", "", () => _("Listen address"), () => _("Host name or address to listen on; empty: every address.")),
    n("nfsd", "port", "2049", () => _("NFS port")),
    n("nfsd", "grace-time", "90", () => _("Grace time (seconds)"), () => _("Time given to clients to recover their locks after a restart.")),
    n("nfsd", "lease-time", "90", () => _("Lease time (seconds)"), () => _("NFSv4 clients renew their state within this time.")),
    b("nfsd", "rdma", "n", () => _("RDMA")),
    n("nfsd", "rdma-port", "20049", () => _("RDMA port")),
    n("nfsd", "debug", "0", () => _("Debug level")),
    n("mountd", "port", "0", () => _("mountd port"), () => _("0 picks a free port at each start. Set a fixed port to allow NFSv3 through a firewall.")),
    b("mountd", "manage-gids", "n", () => _("Look up groups on the server"), () => _("Use the groups of the user on the server instead of the ones sent by the client, which are limited to 16.")),
    n("mountd", "threads", "1", () => _("mountd threads")),
    n("mountd", "descriptors", "0", () => _("Maximum open files of mountd")),
    b("mountd", "reverse-lookup", "n", () => _("Reverse DNS lookup of clients")),
    b("mountd", "cache-use-ipaddr", "n", () => _("Cache by address")),
    n("mountd", "ttl", "1800", () => _("Cache time to live (seconds)")),
    s("mountd", "state-directory-path", "/var/lib/nfs", () => _("State directory")),
    s("mountd", "ha-callout", "", () => _("High availability callout")),
    s("mountd", "debug", "", () => _("mountd debug facilities")),
    n("statd", "port", "0", () => _("statd port"), () => _("Set a fixed port to allow NFSv3 locking through a firewall.")),
    n("statd", "outgoing-port", "0", () => _("statd outgoing port")),
    s("statd", "name", "", () => _("statd host name")),
    s("statd", "state-directory-path", "/var/lib/nfs/statd", () => _("statd state directory")),
    s("statd", "ha-callout", "", () => _("statd high availability callout")),
    b("statd", "no-notify", "0", () => _("Do not notify clients at start")),
    n("statd", "debug", "0", () => _("statd debug level")),
    n("lockd", "port", "0", () => _("lockd TCP port"), () => _("Set a fixed port to allow NFSv3 locking through a firewall.")),
    n("lockd", "udp-port", "0", () => _("lockd UDP port")),
    s("exports", "rootdir", "", () => _("Root of the exported paths"), () => _("Every export path is then relative to this directory.")),
    n("exportfs", "debug", "0", () => _("exportfs debug level")),
    b("exportd", "manage-gids", "n", () => _("exportd: look up groups on the server")),
    n("exportd", "threads", "1", () => _("exportd threads")),
    b("exportd", "cache-use-ipaddr", "n", () => _("exportd: cache by address")),
    n("exportd", "ttl", "1800", () => _("exportd: cache time to live (seconds)")),
    s("exportd", "state-directory-path", "/var/lib/nfs", () => _("exportd state directory")),
    s("nfsdcld", "storagedir", "/var/lib/nfs/nfsdcld", () => _("Client tracking database directory")),
    n("nfsdcld", "debug", "0", () => _("nfsdcld debug level")),
    s("nfsdcltrack", "storagedir", "/var/lib/nfs/nfsdcltrack", () => _("Legacy client tracking directory")),
    b("sm-notify", "force", "0", () => _("Always notify clients at start")),
    n("sm-notify", "retry-time", "900", () => _("Notification retry time (seconds)")),
    b("sm-notify", "lift-grace", "y", () => _("End the grace period after notifying")),
    s("svcgssd", "principal", "", () => _("Kerberos principal of the server")),
];

export function confSetting(section: string, key: string): ConfSetting | undefined {
    return CONF_SETTINGS.find(c => c.section === section && c.key === key);
}

/** nfs.conf booleans: y/yes/true/t/on/1 and n/no/false/f/off/0. */
export function confBoolean(value: string): boolean | null {
    const v = value.trim().toLowerCase();
    if (["y", "yes", "true", "t", "on", "1"].includes(v))
        return true;
    if (["n", "no", "false", "f", "off", "0"].includes(v))
        return false;
    return null;
}
