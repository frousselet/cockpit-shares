# Cockpit Shares

A [Cockpit](https://cockpit-project.org/) page to manage file shares: SMB
shares with Samba and NFS exports with the Linux kernel NFS server. The code is
organized in "providers" so that other protocols can be added later.

![Overview](docs/captures/01-overview.png)

## Features

**Samba server**
- version, NetBIOS name, workgroup, server role;
- `smbd`, `nmbd`, `winbind` and `wsdd` systemd units (start, enable, link to
  the Cockpit Services page); a restart is offered when a setting that is only
  read at startup changes;
- installs Samba with the Cockpit install dialog when it is missing;
- opens the `samba` service in firewalld (Cockpit's own component);
- shows the `testparm` diagnostics of the current configuration.

**Shares**
- list with filter, status, guest access and number of connections;
- guided creation: directory (created with owner, group and mode when
  needed), Standard, Public, macOS (`catia fruit streams_xattr`) and
  Time Machine presets, preview of the lines written;
- details page: Windows and macOS/Linux addresses to copy, directory checks
  (existence, owner, mode, SELinux label with a fix based on
  `semanage fcontext` + `restorecon`, `samba_enable_home_dirs` boolean),
  General, Access and Permissions forms, VFS modules (order, documented
  options, presets for `recycle`, `full_audit`, `shadow_copy2` and `fruit`),
  connected clients;
- enable, disable, rename, duplicate, delete;
- special sections `[homes]`, `[printers]` and `[print$]`;
- shares defined outside `smb.conf` (included files, registry) are shown read
  only.

**Every parameter**
- catalog generated from the Samba 4.25.1 documentation sources: 550
  `smb.conf` parameters (type, scope, accepted values, synonyms, inverted
  synonyms such as `writeable`, default value, documentation) and 177 options
  of 49 VFS modules;
- per section editor (global or share): parameters set in the section, or
  every parameter with the inherited or default value that really applies
  (`testparm -v` of the installed Samba version), search, categories, adding
  any parameter or `module:option`, reset to the default;
- typed editors: booleans, value lists, octal modes (shown as `rwxr-x---`),
  sizes, users and `@groups` with suggestions, paths.

`smb.conf` is never edited as text: every change goes through the forms.

**Samba users**: add from the system accounts, set password, enable, disable,
remove (with a link to the Cockpit Accounts page).

**Connected clients** (`smbstatus`): sessions, protocol, encryption, shares in
use, open files, disconnect one client or every client of a share.

**History of changes**: the versions saved before each change can be compared
with the current configuration and restored.

### NFS

**NFS server**
- nfs-utils version, protocol versions enabled in the kernel server
  (`/proc/fs/nfsd/versions`), configuration files in use;
- `nfs-server` and `rpcbind` systemd units (`rpcbind` only while NFSv3 is
  enabled);
- installs the server with the Cockpit install dialog when it is missing
  (`nfs-kernel-server` on Debian and Ubuntu, `nfs-utils` elsewhere);
- opens the `nfs` service in firewalld, and `mountd` and `rpc-bind` while
  NFSv3 is enabled;
- reports export lines that `exportfs` reads differently from what they seem
  to say, such as `host (rw)`.

**Exports**
- listed in the same table as the SMB shares, with access, clients and a
  "Not exported" label when `exportfs` does not export the directory;
- guided creation: directory (created when needed), first client with a
  suggestion of the local networks, access, user mapping (`root_squash`,
  `no_root_squash`, `all_squash`), ports below 1024 or any port (macOS),
  preview of the line written;
- details page: clients with their options, options in effect according to
  `exportfs -v` (defaults included), mount command and `/etc/fstab` line to
  copy, file and line defining the export, mount point of the directory;
- client editor with every option of `exports(5)` (nfs-utils 2.6.4), grouped
  in Access, User mapping, Security and Advanced, with its documentation;
  options it does not know are refused, as `exportfs` would refuse them;
- add, edit and remove clients, change the path, add a description (written
  as a comment at the end of the line), delete;
- exports defined in `/etc/exports.d/*.exports` are edited in their own file.

**NFS clients**: NFSv4 clients known to the kernel server
(`/proc/fs/nfsd/clients`), with address, name, protocol version and status;
"Disconnect" releases the open files and locks of a client. NFSv3 clients keep
no session and are not listed.

**Server settings** (`/etc/nfs.conf`): protocol versions, transports,
threads, grace and lease times, fixed ports for `mountd`, `statd` and `lockd`
(NFSv3 through a firewall), and every other setting of `nfs.conf(5)`, including
ones this page does not describe. A restart of the NFS server is offered after
a change.

**History of changes**: `/etc/exports` and `/etc/nfs.conf` have their own
history page.

## How changes are applied

### SMB

Every change follows the same path:

1. it is applied to an in-memory copy of the file; the parser keeps everything
   it does not change byte for byte (comments, order, continuation lines, key
   spelling, indentation style);
2. the resulting text is validated by `testparm` on its standard input before
   anything is written; a configuration rejected by `testparm` is not saved;
3. a copy of the current file is stored in `/var/lib/cockpit-shares/backups/`
   (the last 20 versions are kept, see "History of changes");
4. the file is replaced atomically, and the write is refused when the file
   changed on disk in the meantime;
5. `smbcontrol all reload-config` applies the configuration.

The parser follows Samba's own rules (`lib/util/tini.c`,
`lib/param/loadparm.c`): `#` and `;` comments only at the start of a line,
`\` continuation lines, parameter and section names compared ignoring case and
whitespace, `[global]` and `[globals]`, parameters before the first section
belong to `[global]`, the last occurrence wins. A unit test compares the
parser's reading with `testparm` on several files.

### NFS

Changes to an exports file follow the same path, with `exportfs` in place of
`testparm`:

1. the change is applied to an in-memory copy; untouched lines are written
   back byte for byte;
2. the candidate file is checked by `exportfs -ra` in a private mount
   namespace (`unshare --mount`) where it replaces the real file and
   `/var/lib/nfs` is a temporary directory: the system is not changed, and a
   file rejected by `exportfs` is not saved. `exportfs` stops reading at the
   first syntax error and drops the following lines, which is why the check
   happens before the write;
3. a copy of the current file is stored in `/var/lib/cockpit-shares/backups/`;
4. the file is replaced atomically, with the same conflict detection;
5. `exportfs -ra` applies the new table.

The parser follows `exports(5)` and `exportfs` (nfs-utils 2.6.4): `#` starts a
comment that runs to the end of the line, `\` continuation lines, paths quoted
with `"` or written with `\ooo` octal escapes, `-options` default options for
the following clients of the line. A unit test compares the parser's reading
with `exportfs` on several files.

`/etc/nfs.conf` is changed with `nfsconf --set` and `nfsconf --unset`, after a
backup. `nfsconf` keeps the rest of the file and adds a
`# Modified: Cockpit on DATE` line. Setting a value replaces the commented
example of the setting (`# threads=8` becomes `threads = 16`); removing it
deletes the line, and the commented example is not put back.

## Installing on Debian or Ubuntu

Download `cockpit-shares_VERSION_all.deb` from the GitHub releases and install
it with apt, which also pulls the dependencies:

```bash
sudo apt install ./cockpit-shares_0.1.0_all.deb
```

The package contains the prebuilt page: Node.js and npm are not needed on the
machine running Cockpit. Build it with:

```bash
make deb
```

Every pushed tag starts the Release workflow (`.github/workflows/release.yml`):
it runs the unit tests, builds the package and attaches it to the release of
the tag, created when it does not exist. The package version is the tag name
without a leading `v`. For a tag that existed before the workflow, run it from
the Actions tab ("Run workflow") with the tag name.

## Building and installing

Build dependencies: `make`, `gettext`, Node.js and npm (Node.js 22.18 or newer
for the unit tests, which run TypeScript directly).

```bash
make
```

```bash
sudo make install PREFIX=/usr
```

For development, without installing anything system wide:

```bash
make devel-install
```

then run `make` (or `make watch`) and reload the page in Cockpit.

Packaging: `make deb` (Debian, Ubuntu), `make rpm` (Fedora, RHEL, openSUSE)
and `packaging/arch/PKGBUILD.in` (Arch Linux).

## Tests

```bash
make unit-check
```

```bash
make typecheck
```

```bash
npm run eslint
```

`test/e2e/run.cjs` drives the page in a running Cockpit with Playwright and
checks `/etc/samba/smb.conf`, `/etc/exports` and `/etc/nfs.conf` after each
action. It changes the Samba and NFS configuration of the machine: only run it
on a test system.

## Translations

The user interface strings are written in English and translated to French in
`po/fr.po`. After changing strings:

```bash
make po/shares.pot
```

```bash
tools/make-po.py
```

The French translations live in `tools/fr-translations.py`. The Samba
parameter documentation comes from Samba and is shown in English; the NFS
option help is part of the translated strings.

## Parameter catalog

`src/providers/smb/smb-catalog.json` is generated from the Samba sources:

```bash
make catalog SAMBA_TAG=samba-4.25.1
```

## Architecture

```
src/
  app.tsx                   overview, routing, unified share list
  providers/
    types.ts                ShareProvider interface
    index.ts                registered providers
    smb/
      smbconf.ts            lossless smb.conf reader and editor
      catalog.ts            typed access to the parameter catalog
      parsers.ts            testparm, pdbedit, smbstatus, smbd -b, stat
      backend.ts            system calls through the Cockpit bridge
      state.tsx             shared React state (watched file, testparm)
      provider.tsx          ShareProvider implementation for SMB
      ui/                   cards, pages and dialogs
    nfs/
      exports.ts            lossless exports(5) reader and editor
      parsers.ts            exportfs diagnostics, nfsconf --dump
      backend.ts            exportfs, nfsconf, /proc/fs/nfsd, findmnt
      state.tsx             shared React state (watched files, exportfs -v)
      provider.tsx          ShareProvider implementation for NFS
      ui/                   cards, pages and dialogs, option catalog
  lib/
    system.ts               commands, backups, atomic writes
    history.tsx             history page shared by the providers
    services.tsx            systemd unit rows
tools/
  generate-smb-catalog.py   catalog generator
  make-po.py                po/fr.po generator
```

To add a protocol, create `src/providers/NAME/` with an object implementing
`ShareProvider` (`types.ts`) and add it to `src/providers/index.ts`. The
overview then lists its shares in the same table (Protocol column), shows its
status card and its own cards, and the "Create share" button offers a choice
of protocol. Pages below `#/NAME/...` are rendered by the provider.

## Known limitations

- Registry configuration (`config backend = registry`, `include = registry`)
  and included files: the shares they define are shown read only.
- The parameter documentation is Samba's, in English.
- Tested with Cockpit 314, Samba 4.19 and nfs-utils 2.6.4 (Ubuntu 24.04).
  Older Cockpit versions have not been checked. Before Samba 4.16, `smbstatus`
  has no JSON output and the page reads its text output instead.
- NFS: without `unshare` (util-linux), an exports file cannot be checked
  before it is written; `exportfs` then reports its errors after the write,
  and the history page restores the previous version.
- NFS: the list of clients needs Linux 5.3 or newer (`/proc/fs/nfsd/clients`)
  and only shows NFSv4 clients.

## Screenshots

| | |
|---|---|
| ![Create a share](docs/captures/02-create-share.png) | ![Share details](docs/captures/03-share-details.png) |
| ![Global settings](docs/captures/04-global-settings.png) | ![Edit a parameter](docs/captures/05-edit-parameter.png) |
| ![History](docs/captures/06-history.png) | ![Compare with a previous version](docs/captures/07-history-compare.png) |
| ![Create an NFS export](docs/captures/08-nfs-create-export.png) | ![NFS export details](docs/captures/09-nfs-export.png) |
| ![Edit an NFS client](docs/captures/10-nfs-client.png) | ![NFS server settings](docs/captures/11-nfs-settings.png) |

## License

LGPL-2.1-or-later, like Cockpit.
