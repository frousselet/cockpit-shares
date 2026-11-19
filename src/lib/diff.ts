/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Minimal line diff (longest common subsequence) for configuration files.
 */

export type DiffLine =
    | { kind: "same" | "add" | "del", text: string }
    | { kind: "skip", count: number };

export function lineDiff(a: string, b: string, context = 3): DiffLine[] {
    const x = a.split("\n");
    const y = b.split("\n");
    const n = x.length;
    const m = y.length;
    // lcs[i][j] = length of the LCS of x[i..] and y[j..]
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
            lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

    const full: { kind: "same" | "add" | "del", text: string }[] = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && x[i] === y[j]) {
            full.push({ kind: "same", text: x[i] });
            i++;
            j++;
        } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
            full.push({ kind: "add", text: y[j] });
            j++;
        } else {
            full.push({ kind: "del", text: x[i] });
            i++;
        }
    }

    // keep `context` unchanged lines around each change
    const keep = full.map(() => false);
    full.forEach((l, k) => {
        if (l.kind !== "same")
            for (let c = Math.max(0, k - context); c <= Math.min(full.length - 1, k + context); c++)
                keep[c] = true;
    });
    const result: DiffLine[] = [];
    let skipped = 0;
    full.forEach((l, k) => {
        if (keep[k]) {
            if (skipped)
                result.push({ kind: "skip", count: skipped });
            skipped = 0;
            result.push(l);
        } else {
            skipped++;
        }
    });
    if (skipped)
        result.push({ kind: "skip", count: skipped });
    return result;
}
