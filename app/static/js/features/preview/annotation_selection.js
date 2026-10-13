/** Read only complete counter markers, including documents saved by older versions. */
export function nextAnnotationNumber(nodes) {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node.className !== 'Group') continue;
    const children = node.children || [];
    if (!children.some((child) => child.className === 'Circle')) continue;
    const label = children.find((child) => child.className === 'Text')?.attrs?.text;
    const number = Number(label);
    if (Number.isSafeInteger(number) && number > 0 && number < Number.MAX_SAFE_INTEGER) {
      return number + 1;
    }
  }
  return 1;
}

export function selectionRectangle(start, end) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function rectanglesIntersect(left, right) {
  return (
    left.x <= right.x + right.width &&
    left.x + left.width >= right.x &&
    left.y <= right.y + right.height &&
    left.y + left.height >= right.y
  );
}

export function isAnnotationTypingTarget(target) {
  return Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'));
}
