// Builds the sidebar's folder tree from flat project paths.

import { ancestors, basename, compareNames } from './paths.js'

/**
 * @param {{ id: string, path: string }[]} files  editable text files
 * @param {string[]} folders                      explicit (possibly empty) folders
 * @param {{ path: string, size: number }[]} binaries  files only the terminal can use
 * @returns {object[]} nodes: { kind: 'folder'|'file'|'binary', name, path, children?, file?, size? }
 */
export function buildTree(files, folders = [], binaries = []) {
  const root = { kind: 'folder', name: '', path: '', children: [] }
  const folderNodes = new Map([['', root]])

  const folderNode = (path) => {
    let node = folderNodes.get(path)
    if (!node) {
      const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      node = { kind: 'folder', name: basename(path), path, children: [] }
      folderNodes.set(path, node)
      folderNode(parentPath).children.push(node)
    }
    return node
  }

  const parentOf = (path) => {
    const dirs = ancestors(path)
    return folderNode(dirs.at(-1) ?? '')
  }

  for (const folder of folders) folderNode(folder)
  for (const file of files) parentOf(file.path).children.push({ kind: 'file', name: basename(file.path), path: file.path, file })
  const taken = new Set(files.map((f) => f.path))
  for (const binary of binaries) {
    if (!taken.has(binary.path)) parentOf(binary.path).children.push({ kind: 'binary', name: basename(binary.path), path: binary.path, size: binary.size })
  }

  const sort = (node) => {
    node.children.sort((a, b) => {
      if ((a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1
      return compareNames(a.name, b.name)
    })
    for (const child of node.children) if (child.kind === 'folder') sort(child)
  }
  sort(root)
  return root.children
}
