function extractTocTree() {
  const tocRoot = document.querySelector('#toc ul.k-group');

  function parseItems(ul, level = 0) {
    const items = [];
    const lis = ul.querySelectorAll(':scope > li');

    lis.forEach((li) => {
      const titleSpan = li.querySelector('span.Normal > span:last-child');
      const title = titleSpan?.textContent.trim().replace(/\s+/g, ' ') || 'Untitled';
      const indent = '  '.repeat(level);
      items.push(`${indent}- ${title}`);

      const nestedUl = li.querySelector(':scope > ul.k-group');
      if (nestedUl) {
        const children = parseItems(nestedUl, level + 1);
        items.push(...children);
      }
    });

    return items;
  }

  const tocTree = parseItems(tocRoot);
  const textContent = tocTree.join('\n');

  // Create a downloadable file
  const blob = new Blob([textContent], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);

  // Create a temporary <a> element to trigger the download
  const a = document.createElement('a');
  a.href = url;
  a.download = 'toc-tree.txt'; // ← you can change the filename
  document.body.appendChild(a);
  a.click();

  // Cleanup
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  console.log('✅ TOC exported as toc-tree.txt');
}

extractTocTree();
