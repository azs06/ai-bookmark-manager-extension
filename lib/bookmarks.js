// Walks chrome.bookmarks.getTree() output, emitting {url, title, tags} for
// every http(s) bookmark. tags = path of user-created folder titles.
//
// The tree is a nameless root whose children are browser-defined folders
// (Bookmarks bar, Other bookmarks, Mobile bookmarks, and account folders on
// newer builds). Their titles are localized and carry no user intent, so they
// are skipped by position rather than matched by name.
export function flattenBookmarkTree(tree) {
  const out = [];
  for (const root of tree) {
    for (const builtin of root.children ?? []) {
      walk(builtin.children ?? [], [], out);
    }
  }
  return out;
}

function walk(nodes, path, out) {
  for (const node of nodes) {
    if (node.url) {
      if (/^https?:/i.test(node.url)) {
        out.push({ url: node.url, title: node.title || null, tags: path });
      }
      continue;
    }
    if (!node.children) continue;
    walk(node.children, node.title ? [...path, node.title] : path, out);
  }
}
