// SPDX-License-Identifier: LGPL-2.1-or-later
//
// End to end test of the SMB and NFS pages against a running Cockpit on this
// machine. It changes /etc/samba/smb.conf, the Samba account database,
// /etc/exports and /etc/nfs.conf: only run it on a disposable test system.
//
//   COCKPIT_URL=http://127.0.0.1:9090 node test/e2e/run.cjs
//
// Requirements: Playwright (require('playwright')), Samba, a Cockpit session
// with administrative access, the system account given in SMB_TEST_USER
// (default "ubuntu") and the share "projets" created beforehand is not needed:
// the test creates everything it uses.

const { chromium } = require('playwright');
const fs = require('fs');
const assert = require('assert/strict');
const { execFileSync } = require('child_process');

const URL = process.env.COCKPIT_URL || 'http://127.0.0.1:9090';
const CONF = process.env.SMB_CONF || '/etc/samba/smb.conf';
const USER = process.env.SMB_TEST_USER || 'ubuntu';
const conf = () => fs.readFileSync(CONF, 'utf8');
const section = name => {
    const m = conf().match(new RegExp(`^\\[${name.replace(/[$]/g, '\\$&')}\\]\\n((?:(?!\\[).*\\n?)*)`, 'm'));
    return m ? m[1] : null;
};

async function until(fn, what, timeout = 15000) {
    const start = Date.now();
    for (;;) {
        try {
            if (await fn())
                return;
        } catch (e) { /* retry */ }
        if (Date.now() - start > timeout)
            throw new Error('timed out waiting for ' + what);
        await new Promise(resolve => setTimeout(resolve, 250));
    }
}

(async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    const open = async hash => {
        await page.goto(`${URL}/shares#${hash}`);
        const handle = await page.waitForSelector('iframe[name="cockpit1:localhost/shares"]', { state: 'attached', timeout: 20000 });
        const frame = await handle.contentFrame();
        await frame.waitForSelector('#app > *', { state: 'attached' });
        return frame;
    };
    const step = name => console.log('ok -', name);

    for (const name of ['e2e', 'e2e-renamed', 'e2e-copy'])
        assert.equal(section(name), null, `remove [${name}] from ${CONF} before running this test`);
    assert.ok(!fs.existsSync('/srv/e2e-test'), 'remove /srv/e2e-test before running this test');

    let f = await open('/');
    await f.waitForSelector('#shares-list tbody');

    // create a share through the dialog
    await f.click('#create-share');
    // with several protocols the button opens a menu
    if (await f.$('#smb-create-share') === null && await f.$('text=SMB share (Windows, macOS, Linux)') !== null)
        await f.click('text=SMB share (Windows, macOS, Linux)');
    await f.waitForSelector('#smb-create-share');
    const pathInput = '#smb-create-share .pf-v6-c-text-input-group__text-input';
    await f.click(pathInput);
    await f.type(pathInput, '/srv/e2e-test');
    await f.click('text=Create /srv/e2e-test');
    // the dialog checks the path: wait for the directory status
    await f.waitForSelector('#smb-create-share .pf-v6-c-helper-text >> text=does not exist yet');
    await f.fill('#smb-create-name', 'e2e');
    await f.fill('#smb-create-comment', 'End to end');
    await f.click('#smb-preset-public');
    await f.click('#smb-create-share-submit');
    await f.waitForSelector('#smb-share-page');
    await until(() => section('e2e') !== null, '[e2e] in smb.conf');
    assert.match(section('e2e'), /path = \/srv\/e2e-test/);
    assert.match(section('e2e'), /guest ok = yes/);
    assert.ok(fs.statSync('/srv/e2e-test').isDirectory());
    step('create a public share and its directory');

    // disable, then enable again
    await f.click('#smb-share-enabled', { force: true });
    await until(() => /available = no/.test(section('e2e')), 'available = no');
    await f.click('#smb-share-enabled', { force: true });
    await until(() => !/available/.test(section('e2e')), 'available removed');
    step('disable and enable');

    // guided form: make it read only for a user
    await f.click('role=tab[name=/^Access/]');
    await f.click('#smb-share-access-edit');
    await f.waitForSelector('#smb-edit-access');
    await f.selectOption('#smb-field-access-guest-ok', 'no');
    await f.click('#smb-field-access-valid-users input');
    await page.keyboard.type(USER);
    await f.click(`.pf-v6-c-menu__list-item >> text="${USER}"`);
    await f.waitForSelector(`#smb-field-access-valid-users-items >> text=${USER}`);
    await f.click('#smb-edit-access-submit');
    await until(() => /guest ok = no/.test(section('e2e')), 'guest ok = no');
    await until(() => new RegExp(`valid users = ${USER}`).test(section('e2e')), 'valid users');
    step('edit the access card');

    // add any parameter with the generic dialog
    await f.click('role=tab[name=/^All parameters/]');
    await f.click('#smb-param-add-button');
    await f.waitForSelector('#smb-param-add');
    await f.click('#smb-param-add-name input');
    await page.keyboard.type('hide dot files');
    await f.click('.pf-v6-c-menu__list-item >> text="hide dot files"');
    await f.waitForSelector('#smb-param-add-value');
    await f.selectOption('#smb-param-add-value', 'no');
    await f.click('#smb-param-add-submit');
    await until(() => /hide dot files = no/.test(section('e2e')), 'hide dot files = no');
    step('add a parameter from the catalog');

    // and reset it
    await f.click('#param-actions-hide-dot-files');
    await f.click('text=Use the global value');
    await f.click('#smb-param-reset-submit');
    await until(() => !/hide dot files/.test(section('e2e')), 'hide dot files removed');
    step('reset a parameter');

    // VFS module with its recommended options
    await f.click('role=tab[name=/^VFS modules/]');
    await f.click('#smb-vfs-add-button');
    await f.waitForSelector('#smb-vfs-add');
    await f.selectOption('#smb-vfs-module', 'recycle');
    await f.click('#smb-vfs-add-submit');
    await until(() => /vfs objects = recycle/.test(section('e2e')) && /recycle:repository = \.recycle\/%U/.test(section('e2e')), 'recycle module');
    step('add a VFS module');

    // rename, duplicate, delete
    await f.click('#share-actions-e2e');
    await f.click('text=Rename');
    await f.fill('#smb-rename-share-input', 'e2e-renamed');
    await f.click('#smb-rename-share-submit');
    await until(() => section('e2e-renamed') !== null && section('e2e') === null, 'rename');
    step('rename');

    await f.waitForSelector('#share-actions-e2e-renamed');
    await f.click('#share-actions-e2e-renamed');
    await f.click('text=Duplicate');
    await f.fill('#smb-duplicate-share-input', 'e2e-copy');
    await f.click('#smb-duplicate-share-submit');
    await until(() => section('e2e-copy') !== null, 'duplicate');
    assert.match(section('e2e-copy'), /recycle:keeptree = yes/);
    step('duplicate');

    for (const name of ['e2e-copy', 'e2e-renamed']) {
        f = await open('/smb/share/' + name);
        await f.waitForSelector('#share-actions-' + name);
        await f.click('#share-actions-' + name);
        await f.click('.pf-m-danger >> text=Delete');
        await f.click('#smb-delete-share-submit');
        await until(() => section(name) === null, 'delete ' + name);
    }
    step('delete');

    // history: every change above left a copy that can be compared
    f = await open('/smb/history');
    await f.waitForSelector('#config-history tbody tr');
    assert.ok(await f.$('textarea') === null, 'the configuration file must not be editable as text');
    await f.click('#config-history tbody tr >> text=Compare');
    await f.waitForSelector('#smb-backup-dialog .shares-diff');
    step('history of changes');

    // Samba accounts
    f = await open('/');
    await f.waitForSelector(`#smb-user-actions-${USER}`);
    await f.click(`#smb-user-actions-${USER}`);
    await f.click('text=Disable');
    await until(() => /\[D/.test(execFileSync('pdbedit', ['-v', '-u', USER], { encoding: 'utf8' })), 'user disabled');
    await f.click(`#smb-user-actions-${USER}`);
    await f.click('text=Enable');
    await until(() => !/Account Flags:\s+\[D/.test(execFileSync('pdbedit', ['-v', '-u', USER], { encoding: 'utf8' })), 'user enabled');
    step('disable and enable a Samba account');

    // === NFS (skipped when exportfs is not installed) ===
    let haveNfs = true;
    try {
        execFileSync('sh', ['-c', 'command -v exportfs'], { stdio: 'ignore' });
    } catch {
        haveNfs = false;
    }
    if (haveNfs) {
        const EXPORTS = '/etc/exports';
        const exportsLine = p => fs.readFileSync(EXPORTS, 'utf8').split('\n').find(l => l.startsWith(p + ' ')) ?? null;
        const exported = () => execFileSync('exportfs', ['-v'], { encoding: 'utf8' });
        assert.equal(exportsLine('/srv/e2e-nfs'), null, 'remove /srv/e2e-nfs from /etc/exports before running this test');
        assert.ok(!fs.existsSync('/srv/e2e-nfs'), 'remove /srv/e2e-nfs before running this test');

        f = await open('/');
        await f.waitForSelector('#shares-list tbody');
        await f.click('#create-share');
        await f.click('text=NFS export (Linux, UNIX)');
        await f.waitForSelector('#nfs-create-export');
        const nfsPath = '#nfs-create-export .pf-v6-c-text-input-group__text-input';
        await f.click(nfsPath);
        await f.type(nfsPath, '/srv/e2e-nfs');
        await f.click('text=Create /srv/e2e-nfs');
        await f.waitForSelector('#nfs-create-mkdir');
        await f.click('#nfs-create-ro');
        await f.click('#nfs-create-export-submit');
        await f.waitForSelector('#nfs-export-page');
        await until(() => exportsLine('/srv/e2e-nfs') === '/srv/e2e-nfs *(ro,sync,no_subtree_check)', 'export line');
        await until(() => /\/srv\/e2e-nfs\s+<world>\(.*\bro\b/.test(exported()), 'exported by exportfs');
        assert.ok(fs.statSync('/srv/e2e-nfs').isDirectory());
        step('create an NFS export and its directory');

        await f.click('#nfs-add-client');
        await f.waitForSelector('#nfs-client-dialog');
        await f.click('#nfs-client-host input');
        await page.keyboard.type('10.20.0.0/16');
        await f.click('text=Use "10.20.0.0/16"');
        await f.selectOption('#nfs-opt-all_squash', 'all_squash');
        await f.fill('#nfs-opt-anonuid', '1000');
        await f.click('#nfs-client-dialog-submit');
        await until(() => exportsLine('/srv/e2e-nfs') === '/srv/e2e-nfs *(ro,sync,no_subtree_check) 10.20.0.0/16(rw,sync,no_subtree_check,all_squash,anonuid=1000)', 'client added');
        step('add a client with options');

        // an option that exportfs refuses is not written
        await f.click('#nfs-export-clients tr[data-client="10.20.0.0/16"] button.pf-m-link');
        await f.waitForSelector('#nfs-client-dialog');
        await f.fill('#nfs-opt-other', 'bogus_option');
        await page.keyboard.press('Enter');
        assert.ok(await f.isDisabled('#nfs-client-dialog-submit'), 'unknown options block the dialog');
        await f.click('#nfs-client-dialog-cancel');
        step('unknown options are refused');

        await f.click('#nfs-export-actions');
        await f.click('text=Change path');
        await f.fill('#nfs-change-path-input', '/srv/e2e-nfs-moved');
        await f.click('#nfs-change-path-submit');
        await until(() => exportsLine('/srv/e2e-nfs-moved') !== null && exportsLine('/srv/e2e-nfs') === null, 'path changed');
        step('change the path of an export');

        await f.waitForSelector('#nfs-export-actions');
        await f.click('#nfs-export-actions');
        await f.click('.pf-m-danger >> text=Delete');
        await f.click('#nfs-delete-export-submit');
        await until(() => exportsLine('/srv/e2e-nfs-moved') === null, 'export deleted');
        step('delete an export');

        // server settings through nfsconf
        const before = fs.readFileSync('/etc/nfs.conf', 'utf8');
        f = await open('/nfs/settings');
        await f.waitForSelector('#nfs-conf-server-edit');
        await f.click('#nfs-conf-server-edit');
        await f.waitForSelector('#nfs-conf-server');
        await f.fill('#nfs-conf-nfsd-threads', '12');
        await f.click('#nfs-conf-server-submit');
        await until(() => /^threads = 12$/m.test(fs.readFileSync('/etc/nfs.conf', 'utf8')), 'threads written');
        await f.waitForSelector('[data-setting="nfsd.threads"] >> text=12');
        await f.click('#nfs-conf-server-edit');
        await f.fill('#nfs-conf-nfsd-threads', '');
        await f.click('#nfs-conf-server-submit');
        await until(() => !/^threads = 12$/m.test(fs.readFileSync('/etc/nfs.conf', 'utf8')), 'threads removed');
        assert.ok(fs.readFileSync('/etc/nfs.conf', 'utf8').includes('[nfsd]'), 'nfs.conf keeps its sections');
        assert.notEqual(before.length, 0);
        step('change and reset a server setting');

        f = await open('/nfs/history');
        await f.waitForSelector('#config-history tbody tr');
        step('NFS history of changes');
    }

    assert.deepEqual(errors, []);
    console.log('all end to end checks passed');
    await browser.close();
})().catch(async e => {
    console.error('FAILED:', e.message);
    process.exit(1);
});
