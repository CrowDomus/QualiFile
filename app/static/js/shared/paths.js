/**
 * Shared helpers for working with QualiFile's filesystem paths.
 */

/**
 * Normalise dot-prefixed paths for comparison.
 *
 * @param {string} path - The path to normalise.
 * @returns {string} A trimmed path without leading './' or trailing '/'.
 */
export function normalizePath(path) {
  if (!path || path === '.') return '';
  return String(path)
    .replace(/\\/g, '/')
    .replace(/^\.\/?/, '')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '');
}

/**
 * Determine whether moving items into a destination would create
 * invalid cycles (e.g., moving a folder into itself or a descendant).
 *
 * @param {string[]} items - Paths of the items being moved.
 * @param {string} destination - Target destination path.
 * @returns {boolean} True when the move would be invalid.
 */
export function isInvalidDestination(items, destination) {
  const target = normalizePath(destination);
  if (!target) return false;
  return items.some((item) => {
    const source = normalizePath(item);
    if (!source) return false;
    return source === target || target.startsWith(`${source}/`);
  });
}
