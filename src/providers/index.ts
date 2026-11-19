/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Registered share providers. To support another protocol, implement
 * ShareProvider (see types.ts) in providers/<protocol>/ and add it here.
 */

import type { ShareProvider } from "./types.ts";
import { smbProvider } from "./smb/provider.tsx";

export const PROVIDERS: ShareProvider[] = [smbProvider];
