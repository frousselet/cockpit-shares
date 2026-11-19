/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Translated labels for the smb.conf parameters shown in the guided forms.
 * Every other parameter is shown with its smb.conf name, which is what the
 * Samba documentation and every tutorial use.
 */

import cockpit from "cockpit";

const _ = cockpit.gettext;

export function categoryLabel(category: string): string {
    switch (category) {
    case "base": return _("Base");
    case "browse": return _("Browsing");
    case "domain": return _("Domain");
    case "filename": return _("File names");
    case "ldap": return _("LDAP");
    case "locking": return _("Locking");
    case "logging": return _("Logging");
    case "logon": return _("Logon");
    case "misc": return _("Miscellaneous");
    case "printing": return _("Printing");
    case "protocol": return _("Protocol");
    case "rpc": return _("RPC services");
    case "security": return _("Security");
    case "tuning": return _("Tuning");
    case "vfs": return _("VFS modules");
    case "winbind": return _("Winbind");
    case "wins": return _("WINS");
    case "parametric": return _("Module options");
    case "unknown": return _("Unknown");
    default: return category;
    }
}

export interface FieldSpec {
    name: string;
    label: () => string;
    help?: () => string;
    kind?: "path" | "principals" | "hosts" | "text" | "mode";
}

export interface FieldGroup {
    id: string;
    title: () => string;
    description: () => string;
    fields: FieldSpec[];
}

/* === share forms ================================================= */

export const SHARE_GENERAL: FieldGroup = {
    id: "general",
    title: () => _("General"),
    description: () => _("Directory, description and visibility of the share."),
    fields: [
        { name: "path", label: () => _("Path"), kind: "path", help: () => _("Directory made available by this share.") },
        { name: "comment", label: () => _("Description"), help: () => _("Shown next to the share name by clients.") },
        { name: "available", label: () => _("Enabled") },
        { name: "browseable", label: () => _("Visible in the share list") },
        { name: "read only", label: () => _("Read only") },
        { name: "max connections", label: () => _("Maximum connections"), help: () => _("0 means unlimited.") },
    ],
};

export const SHARE_ACCESS: FieldGroup = {
    id: "access",
    title: () => _("Access"),
    description: () => _("Users, groups and hosts allowed to connect."),
    fields: [
        { name: "guest ok", label: () => _("Allow guest access"), help: () => _("Clients can connect without a password, as the guest account.") },
        { name: "guest only", label: () => _("Guest access only") },
        { name: "valid users", label: () => _("Allowed users and groups"), kind: "principals", help: () => _("Empty: every authenticated user.") },
        { name: "invalid users", label: () => _("Denied users and groups"), kind: "principals" },
        { name: "read list", label: () => _("Read only for"), kind: "principals" },
        { name: "write list", label: () => _("Writable for"), kind: "principals" },
        { name: "admin users", label: () => _("Administrators"), kind: "principals", help: () => _("These users act as root on this share.") },
        { name: "hosts allow", label: () => _("Allowed hosts"), kind: "hosts", help: () => _("Addresses, networks or host names, for example 192.168.1. or 10.0.0.0/8.") },
        { name: "hosts deny", label: () => _("Denied hosts"), kind: "hosts" },
        { name: "access based share enum", label: () => _("Hide the share from users without access") },
        { name: "hide unreadable", label: () => _("Hide unreadable files") },
    ],
};

export const SHARE_PERMISSIONS: FieldGroup = {
    id: "permissions",
    title: () => _("Permissions"),
    description: () => _("Owner and permissions of the files and directories created through the share."),
    fields: [
        { name: "force user", label: () => _("Access files as user") },
        { name: "force group", label: () => _("Access files as group") },
        { name: "create mask", label: () => _("Permissions of new files"), kind: "mode" },
        { name: "force create mode", label: () => _("Permissions always set on new files"), kind: "mode" },
        { name: "directory mask", label: () => _("Permissions of new directories"), kind: "mode" },
        { name: "force directory mode", label: () => _("Permissions always set on new directories"), kind: "mode" },
        { name: "inherit permissions", label: () => _("Inherit permissions from the parent directory") },
        { name: "inherit acls", label: () => _("Inherit ACLs from the parent directory") },
        { name: "inherit owner", label: () => _("Inherit owner") },
        { name: "nt acl support", label: () => _("Map Windows ACLs") },
        { name: "map archive", label: () => _("Map the archive attribute") },
        { name: "store dos attributes", label: () => _("Store DOS attributes in extended attributes") },
        { name: "hide dot files", label: () => _("Hide files starting with a dot") },
        { name: "veto files", label: () => _("Hidden and inaccessible files"), help: () => _("Patterns separated by /, for example /*.tmp/.DS_Store/.") },
        { name: "follow symlinks", label: () => _("Follow symbolic links") },
        { name: "wide links", label: () => _("Follow links outside the share") },
    ],
};

/* === global forms ================================================ */

export const GLOBAL_IDENTITY: FieldGroup = {
    id: "identity",
    title: () => _("Server identity"),
    description: () => _("Names under which the server appears on the network."),
    fields: [
        { name: "workgroup", label: () => _("Workgroup or domain") },
        { name: "netbios name", label: () => _("Server name"), help: () => _("NetBIOS name, 15 characters at most.") },
        { name: "server string", label: () => _("Server description") },
        { name: "server role", label: () => _("Server role") },
        { name: "realm", label: () => _("Kerberos realm") },
    ],
};

export const GLOBAL_SECURITY: FieldGroup = {
    id: "security",
    title: () => _("Security"),
    description: () => _("Authentication, protocol versions, encryption and signing."),
    fields: [
        { name: "security", label: () => _("Authentication") },
        { name: "map to guest", label: () => _("Map unknown users to guest") },
        { name: "guest account", label: () => _("Guest account") },
        { name: "server min protocol", label: () => _("Minimum protocol") },
        { name: "server max protocol", label: () => _("Maximum protocol") },
        { name: "server smb encrypt", label: () => _("Encryption") },
        { name: "server signing", label: () => _("Signing") },
        { name: "ntlm auth", label: () => _("NTLM authentication") },
        { name: "restrict anonymous", label: () => _("Restrict anonymous access") },
        { name: "passdb backend", label: () => _("Account database") },
        { name: "username map", label: () => _("Username map file"), kind: "path" },
    ],
};

export const GLOBAL_NETWORK: FieldGroup = {
    id: "network",
    title: () => _("Network"),
    description: () => _("Interfaces, ports and name announcement."),
    fields: [
        { name: "interfaces", label: () => _("Interfaces"), help: () => _("Interface names or addresses, for example eth0 192.168.1.10/24.") },
        { name: "bind interfaces only", label: () => _("Listen on these interfaces only") },
        { name: "hosts allow", label: () => _("Allowed hosts"), kind: "hosts" },
        { name: "hosts deny", label: () => _("Denied hosts"), kind: "hosts" },
        { name: "smb ports", label: () => _("TCP ports") },
        { name: "disable netbios", label: () => _("Disable NetBIOS") },
        { name: "multicast dns register", label: () => _("Announce with multicast DNS (Bonjour)") },
        { name: "server multi channel support", label: () => _("Multichannel") },
    ],
};

export const GLOBAL_LOGGING: FieldGroup = {
    id: "logging",
    title: () => _("Logging"),
    description: () => _("Log level and destinations."),
    fields: [
        { name: "log level", label: () => _("Log level") },
        { name: "logging", label: () => _("Log destinations") },
        { name: "log file", label: () => _("Log file") },
        { name: "max log size", label: () => _("Maximum log size (KiB)") },
    ],
};

export const GLOBAL_SHARING: FieldGroup = {
    id: "sharing",
    title: () => _("File sharing"),
    description: () => _("Printers, user shares and UNIX extensions."),
    fields: [
        { name: "load printers", label: () => _("Share printers") },
        { name: "printing", label: () => _("Printing system") },
        { name: "usershare max shares", label: () => _("Maximum user shares"), help: () => _("0 disables shares created by users with net usershare.") },
        { name: "usershare allow guests", label: () => _("Allow guest access to user shares") },
        { name: "unix extensions", label: () => _("SMB1 UNIX extensions") },
        { name: "smb3 unix extensions", label: () => _("SMB3 POSIX extensions") },
    ],
};

/** Global parameters whose change needs a restart of the daemons. */
export const RESTART_PARAMETERS = new Set([
    "interfaces", "bind interfaces only", "smb ports", "disable netbios", "netbios name", "netbios aliases",
    "server role", "security", "workgroup", "realm", "passdb backend", "server services", "dcerpc endpoint servers",
    "server multi channel support", "nmbd bind explicit broadcast", "socket options", "max smbd processes",
    "rpc start on demand helpers", "multicast dns register", "lock directory", "state directory", "cache directory",
    "pid directory", "private dir",
]);
