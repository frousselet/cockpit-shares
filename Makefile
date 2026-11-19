# extract name from package.json
PACKAGE_NAME := $(shell awk '/"name":/ {gsub(/[",]/, "", $$2); print $$2}' package.json)
RPM_NAME := cockpit-$(PACKAGE_NAME)
VERSION := $(shell T=$$(git describe 2>/dev/null) || T=1; echo $$T | tr '-' '.')
ifeq ($(TEST_OS),)
TEST_OS = centos-9-stream
endif
export TEST_OS
TARFILE=$(RPM_NAME)-$(VERSION).tar.xz
NODE_CACHE=$(RPM_NAME)-node-$(VERSION).tar.xz
SPEC=$(RPM_NAME).spec
PREFIX ?= /usr/local
APPSTREAMFILE=org.cockpit_project.$(subst -,_,$(PACKAGE_NAME)).metainfo.xml
VM_IMAGE=$(CURDIR)/test/images/$(TEST_OS)
# stamp file to check for node_modules/
NODE_MODULES_TEST=package-lock.json
# build.js ran in non-watch mode
DIST_TEST=runtime-npm-modules.txt
# one example file in pkg/lib to check if it was already checked out
COCKPIT_REPO_STAMP=pkg/lib/cockpit-po-plugin.js
# common arguments for tar, mostly to make the generated tarballs reproducible
TAR_ARGS = --sort=name --mtime "@$(shell git show --no-patch --format='%at' 2>/dev/null || date +%s)" --mode=go=rX,u+rw,a-s --numeric-owner --owner=0 --group=0

all: $(DIST_TEST)

# checkout common files from Cockpit repository required to build this project;
# this has no API stability guarantee, so check out a stable tag when you start
# a new project, use the latest release, and update it from time to time
COCKPIT_REPO_FILES = \
	pkg/lib \
	test/common \
	tools/node-modules \
	$(NULL)

COCKPIT_REPO_URL = https://github.com/cockpit-project/cockpit.git
COCKPIT_REPO_COMMIT = e09f69218bfeb1bf2dd822218f77a36dd34b086a # 372 + 19 commits

$(COCKPIT_REPO_FILES): $(COCKPIT_REPO_STAMP)
COCKPIT_REPO_TREE = '$(strip $(COCKPIT_REPO_COMMIT))^{tree}'
$(COCKPIT_REPO_STAMP): Makefile
	@test -d .git || git init -q
	@git rev-list --quiet --objects $(COCKPIT_REPO_TREE) -- 2>/dev/null || \
	    git fetch --no-tags --no-write-fetch-head --depth=1 $(COCKPIT_REPO_URL) $(COCKPIT_REPO_COMMIT)
	git archive $(COCKPIT_REPO_TREE) -- $(COCKPIT_REPO_FILES) | tar x

#
# i18n
#

LINGUAS=$(basename $(notdir $(wildcard po/*.po)))

# shared Cockpit components used by this page; their strings are part of our catalog
PKG_LIB_I18N_FILES = \
	pkg/lib/cockpit-components-dialog.jsx \
	pkg/lib/cockpit-components-dropdown.tsx \
	pkg/lib/cockpit-components-empty-state.tsx \
	pkg/lib/cockpit-components-file-autocomplete.tsx \
	pkg/lib/cockpit-components-firewalld-request.jsx \
	pkg/lib/cockpit-components-inline-notification.tsx \
	pkg/lib/cockpit-components-install-dialog.jsx \
	pkg/lib/cockpit-components-multi-typeahead-select.tsx \
	pkg/lib/cockpit-components-password.tsx \
	pkg/lib/cockpit-components-table.tsx \
	pkg/lib/cockpit-components-typeahead-select.tsx \
	$(NULL)

po/$(PACKAGE_NAME).js.pot: $(COCKPIT_REPO_STAMP)
	xgettext --default-domain=$(PACKAGE_NAME) --output=- --language=C --keyword= \
		--add-comments=Translators: \
		--keyword=_:1,1t --keyword=_:1c,2,2t --keyword=C_:1c,2 \
		--keyword=N_ --keyword=NC_:1c,2 \
		--keyword=gettext:1,1t --keyword=gettext:1c,2,2t \
		--keyword=ngettext:1,2,3t --keyword=ngettext:1c,2,3,4t \
		--keyword=gettextCatalog.getString:1,3c --keyword=gettextCatalog.getPlural:2,3,4c \
		--from-code=UTF-8 $$(find src/ -name '*.[jt]s' -o -name '*.[jt]sx') $(PKG_LIB_I18N_FILES) | \
		sed '/^#/ s/, c-format//' > $@ && \
		sed -i 's/charset=CHARSET/charset=UTF-8/g' $@

po/$(PACKAGE_NAME).html.pot: $(NODE_MODULES_TEST) $(COCKPIT_REPO_STAMP)
	pkg/lib/html2po -o $@ $$(find src -name '*.html')

po/$(PACKAGE_NAME).manifest.pot: $(COCKPIT_REPO_STAMP)
	pkg/lib/manifest2po -o $@ src/manifest.json

po/$(PACKAGE_NAME).metainfo.pot: $(APPSTREAMFILE)
	xgettext --default-domain=$(PACKAGE_NAME) --output=$@ $< && \
	sed -i 's/charset=CHARSET/charset=UTF-8/g' $@

po/$(PACKAGE_NAME).pot: po/$(PACKAGE_NAME).html.pot po/$(PACKAGE_NAME).js.pot po/$(PACKAGE_NAME).manifest.pot po/$(PACKAGE_NAME).metainfo.pot
	xgettext --output=$@ $^

po/LINGUAS:
	echo $(LINGUAS) | tr ' ' '\n' > $@

# merge the current template into every translation
update-po: po/$(PACKAGE_NAME).pot
	for lang in $(LINGUAS); do \
		msgmerge --quiet --update --backup=none --no-fuzzy-matching po/$$lang.po po/$(PACKAGE_NAME).pot; \
	done

#
# smb.conf parameter catalog, generated from the Samba documentation sources
#

SAMBA_TAG ?= samba-4.25.1
SAMBA_REPO_URL = https://github.com/samba-team/samba.git
SAMBA_SRC = tmp/samba-$(SAMBA_TAG)

$(SAMBA_SRC):
	mkdir -p $@
	cd $@ && git init -q && git remote add origin $(SAMBA_REPO_URL) && \
	    git config core.sparseCheckout true && \
	    printf 'docs-xml/smbdotconf/\ndocs-xml/manpages/\nlib/param/\n' > .git/info/sparse-checkout && \
	    git fetch -q --depth 1 --filter=blob:none origin tag $(SAMBA_TAG) && git checkout -q $(SAMBA_TAG)

catalog: $(SAMBA_SRC)
	tools/generate-smb-catalog.py $(SAMBA_SRC) $(patsubst samba-%,%,$(SAMBA_TAG)) src/providers/smb/smb-catalog.json

#
# Build/Install/dist
#

$(SPEC): packaging/$(SPEC).in $(DIST_TEST)
	provides=$$(awk '{print "Provides: bundled(npm(" $$1 ")) = " $$2}' runtime-npm-modules.txt); \
	awk -v p="$$provides" '{gsub(/%{VERSION}/, "$(VERSION)"); gsub(/%{NPM_PROVIDES}/, p)}1' $< > $@

packaging/arch/PKGBUILD: packaging/arch/PKGBUILD.in
	sed 's/VERSION/$(VERSION)/; s/SOURCE/$(TARFILE)/' $< > $@

$(DIST_TEST): $(NODE_MODULES_TEST) $(COCKPIT_REPO_STAMP) $(shell find src/ -type f) package.json build.js
	NODE_ENV=$(NODE_ENV) ./build.js

watch: $(NODE_MODULES_TEST) $(COCKPIT_REPO_STAMP)
	NODE_ENV=$(NODE_ENV) ./build.js --watch

clean:
	rm -rf dist/
	rm -f $(SPEC) packaging/arch/PKGBUILD
	rm -f po/LINGUAS po/*.pot
	rm -f metafile.json runtime-npm-modules.txt

install: $(DIST_TEST) po/LINGUAS
	mkdir -p $(DESTDIR)$(PREFIX)/share/cockpit/$(PACKAGE_NAME)
	cp -r dist/* $(DESTDIR)$(PREFIX)/share/cockpit/$(PACKAGE_NAME)
	mkdir -p $(DESTDIR)$(PREFIX)/share/metainfo/
	msgfmt --xml -d po \
		--template $(APPSTREAMFILE) \
		-o $(DESTDIR)$(PREFIX)/share/metainfo/$(APPSTREAMFILE)

# this requires a built source tree and avoids having to install anything system-wide
devel-install: $(DIST_TEST)
	mkdir -p ~/.local/share/cockpit
	ln -s `pwd`/dist ~/.local/share/cockpit/$(PACKAGE_NAME)

# assumes that there was symlink set up using the above devel-install target,
# and removes it
devel-uninstall:
	rm -f ~/.local/share/cockpit/$(PACKAGE_NAME)

print-version:
	@echo "$(VERSION)"

dist: $(TARFILE)
	@ls -1 $(TARFILE)

# Debian package with the prebuilt page: the target machine needs neither
# Node.js nor npm. Only dpkg-deb is needed besides the build dependencies.
DEBFILE = $(RPM_NAME)_$(VERSION)_all.deb
DEB_ROOT = tmp/deb

deb: $(DEBFILE)
	@ls -1 $(DEBFILE)

$(DEBFILE): $(DIST_TEST) po/LINGUAS packaging/debian/control.in packaging/debian/copyright
	NODE_ENV=production ./build.js
	rm -rf $(DEB_ROOT)
	$(MAKE) install DESTDIR=$(CURDIR)/$(DEB_ROOT) PREFIX=/usr
	find $(DEB_ROOT) -name '*.map' -delete
	install -D -m 644 packaging/debian/copyright $(DEB_ROOT)/usr/share/doc/$(RPM_NAME)/copyright
	mkdir -p $(DEB_ROOT)/DEBIAN
	sed -e 's/@VERSION@/$(VERSION)/' -e "s/@SIZE@/$$(du -sk $(DEB_ROOT)/usr | cut -f1)/" \
		packaging/debian/control.in > $(DEB_ROOT)/DEBIAN/control
	dpkg-deb --root-owner-group --build $(DEB_ROOT) $@
	# leave a development build behind, as "make" does
	./build.js

# source files: the tracked files of a git checkout, or this list
SOURCE_FILES = $(shell (git ls-files 2>/dev/null | grep .) || echo \
	.eslintignore .eslintrc.json .gitignore .stylelintrc.json LICENSE Makefile README.md \
	build.js package.json tsconfig.json org.cockpit_project.shares.metainfo.xml \
	docs packaging/arch/PKGBUILD.in po/fr.po src test/unit test/e2e tools)

# when building a distribution tarball, call bundler with a 'production' environment
# we don't ship node_modules for license and compactness reasons; we ship a
# pre-built dist/ (so it's not necessary) and ship package-lock.json (so that
# node_modules/ can be reconstructed if necessary)
$(TARFILE): export NODE_ENV=production
$(TARFILE): $(DIST_TEST) $(SPEC) packaging/arch/PKGBUILD
	if type appstream-util >/dev/null 2>&1; then appstream-util validate-relax --nonet *.metainfo.xml; fi
	tar --xz $(TAR_ARGS) -cf $(TARFILE) --transform 's,^,$(RPM_NAME)/,' \
		--exclude packaging/$(SPEC).in --exclude node_modules --exclude tmp \
		$(SOURCE_FILES) \
		$(COCKPIT_REPO_FILES) $(NODE_MODULES_TEST) $(DIST_TEST) \
		$(SPEC) packaging/arch/PKGBUILD dist/

$(NODE_CACHE): $(NODE_MODULES_TEST)
	tools/node-modules runtime-tar $(NODE_CACHE)

node-cache: $(NODE_CACHE)

# convenience target for developers
srpm: $(TARFILE) $(NODE_CACHE) $(SPEC)
	rpmbuild -bs \
	  --define "_sourcedir `pwd`" \
	  --define "_srcrpmdir `pwd`" \
	  $(SPEC)

# convenience target for developers
rpm: $(TARFILE) $(NODE_CACHE) $(SPEC)
	mkdir -p "`pwd`/output"
	mkdir -p "`pwd`/rpmbuild"
	rpmbuild -bb \
	  --define "_sourcedir `pwd`" \
	  --define "_specdir `pwd`" \
	  --define "_builddir `pwd`/rpmbuild" \
	  --define "_srcrpmdir `pwd`" \
	  --define "_rpmdir `pwd`/output" \
	  --define "_buildrootdir `pwd`/build" \
	  $(SPEC)
	find `pwd`/output -name '*.rpm' -printf '%f\n' -exec mv {} . \;
	rm -r "`pwd`/rpmbuild"
	rm -r "`pwd`/output" "`pwd`/build"

# build a VM with locally built distro pkgs installed
# disable networking, VM images have mock/pbuilder with the common build dependencies pre-installed
$(VM_IMAGE): export XZ_OPT=-0
$(VM_IMAGE): $(TARFILE) $(NODE_CACHE) bots test/vm.install
	bots/image-customize --no-network --fresh \
		--upload $(NODE_CACHE):/var/tmp/ --build $(TARFILE) \
		--script $(CURDIR)/test/vm.install $(TEST_OS)

# convenience target for the above
vm: $(VM_IMAGE)
	@echo $(VM_IMAGE)

# convenience target to print the filename of the test image
print-vm:
	@echo $(VM_IMAGE)

# convenience target to setup all the bits needed for the integration tests
# without actually running them
prepare-check: $(NODE_MODULES_TEST) $(VM_IMAGE) test/common

# run the browser integration tests
# this will run all tests/check-* and format them as TAP
check: prepare-check
	test/common/run-tests ${RUN_TESTS_OPTIONS}

# unit tests of the smb.conf, pdbedit and smbstatus parsers (no browser or VM needed)
unit-check: $(NODE_MODULES_TEST) $(COCKPIT_REPO_STAMP)
	node --test test/unit/*.test.ts

typecheck: $(NODE_MODULES_TEST) $(COCKPIT_REPO_STAMP)
	npx tsc --noEmit

codecheck: test/common $(NODE_MODULES_TEST)
	test/common/static-code

# checkout Cockpit's bots for standard test VM images and API to launch them
bots: $(COCKPIT_REPO_STAMP)
	test/common/make-bots

$(NODE_MODULES_TEST): package.json
	@command -v npm >/dev/null 2>&1 || { \
	    echo "error: npm is required to build this page. Install Node.js and npm, for example:"; \
	    echo "  Debian, Ubuntu:   sudo apt install nodejs npm gettext make"; \
	    echo "  Fedora, RHEL:     sudo dnf install nodejs npm gettext make"; \
	    echo "  openSUSE:         sudo zypper in nodejs npm gettext-runtime make"; \
	    echo "  Arch Linux:       sudo pacman -S nodejs npm gettext make"; \
	    exit 1; }
	# if it exists already, npm install won't update it; force that so that we always get up-to-date packages
	rm -f package-lock.json
	# unset NODE_ENV, skips devDependencies otherwise; this often hangs, so try a few times
	for _ in `seq 3`; do timeout 10m env -u NODE_ENV npm install --ignore-scripts && exit 0; done; exit 1
	env -u NODE_ENV npm prune

.PHONY: deb all clean install devel-install devel-uninstall print-version dist node-cache rpm prepare-check check vm print-vm update-po catalog unit-check typecheck
