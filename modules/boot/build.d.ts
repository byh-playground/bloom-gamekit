/**
 * Types for `dist/boot-build.mjs`. Lists every local module an entry loads through static import/export-from and
 * string-literal dynamic import(), as root-relative POSIX paths: the entry first, then breadth-first in import order.
 * Absolute URL specifiers (https:) are left out. Throws on a missing file, a path outside root, or a specifier that
 * is neither `./` nor `../` relative.
 */
export function listModuleGraph(options: { root: string; entry: string }): string[];
