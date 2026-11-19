// SPDX-License-Identifier: LGPL-2.1-or-later
//
// End to end test of the SMB page against a running Cockpit on this machine.
// It changes /etc/samba/smb.conf and the Samba account database: only run it
// on a disposable test system.
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
    await f.waitForSelector('#smb-config-history tbody tr');
    assert.ok(await f.$('textarea') === null, 'the configuration file must not be editable as text');
    await f.click('#smb-config-history tbody tr >> text=Compare');
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

    assert.deepEqual(errors, []);
    console.log('all end to end checks passed');
    await browser.close();
})().catch(async e => {
    console.error('FAILED:', e.message);
    process.exit(1);
});
