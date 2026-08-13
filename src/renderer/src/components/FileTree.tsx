import type { TreeNode, TreeRoot } from '../../../shared/types'

/**
 * The project's folders, one level at a time: every file is reachable, but a
 * folder is only read once it is expanded. Roots are the tab's own folder and
 * each added directory, as siblings.
 */
interface Props {
  roots: TreeRoot[]
  /** entries read for every folder opened so far, by folder path */
  entries: Map<string, TreeNode[]>
  expanded: Set<string>
  selectedPath?: string
  onToggle: (dir: string) => void
  onOpen: (node: TreeNode) => void
}

/** Indent per level; the twisty column is part of the row, so this only has to
 *  make nesting readable. */
const STEP = 11

export function FileTree({
  roots,
  entries,
  expanded,
  selectedPath,
  onToggle,
  onOpen
}: Props): React.JSX.Element {
  const folderRow = (
    path: string,
    label: string,
    depth: number,
    subtitle?: string
  ): React.JSX.Element => {
    const open = expanded.has(path)
    return (
      <button
        key={path}
        className="docs-tree-row"
        style={{ paddingLeft: 4 + depth * STEP }}
        onClick={() => onToggle(path)}
        title={subtitle ?? path}
      >
        <span className="docs-twisty">{open ? '▾' : '▸'}</span>
        <span className="docs-tree-name">{label}</span>
      </button>
    )
  }

  const fileRow = (node: TreeNode, depth: number): React.JSX.Element => (
    <button
      key={node.path}
      className={`docs-tree-row file ${selectedPath === node.path ? 'active' : ''}`}
      style={{ paddingLeft: 4 + depth * STEP }}
      onClick={() => onOpen(node)}
      title={node.path}
    >
      <span className="docs-twisty" />
      <span className="docs-tree-name">{node.name}</span>
    </button>
  )

  /** A folder's rows: the folder itself, then its children when expanded. */
  const rowsFor = (
    path: string,
    label: string,
    depth: number,
    subtitle?: string
  ): React.JSX.Element[] => {
    const rows = [folderRow(path, label, depth, subtitle)]
    if (!expanded.has(path)) return rows
    const kids = entries.get(path)
    if (!kids) {
      rows.push(
        <div
          key={`${path}:loading`}
          className="docs-tree-note"
          style={{ paddingLeft: 4 + (depth + 1) * STEP }}
        >
          …
        </div>
      )
      return rows
    }
    if (!kids.length) {
      rows.push(
        <div
          key={`${path}:empty`}
          className="docs-tree-note"
          style={{ paddingLeft: 4 + (depth + 1) * STEP }}
        >
          empty
        </div>
      )
      return rows
    }
    for (const kid of kids) {
      if (kid.isDir) rows.push(...rowsFor(kid.path, kid.name, depth + 1))
      else rows.push(fileRow(kid, depth + 1))
    }
    return rows
  }

  return (
    <div className="docs-section docs-tree">
      <div className="docs-section-title">Files</div>
      {roots.map((root) => rowsFor(root.path, root.name, 0, root.subtitle))}
    </div>
  )
}
