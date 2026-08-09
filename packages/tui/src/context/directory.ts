import path from "path"
import { createMemo } from "solid-js"
import { useProject } from "./project"
import { useSync } from "./sync"
import { useTuiPaths } from "./runtime"

export function useDirectory() {
  const project = useProject()
  const sync = useSync()
  const paths = useTuiPaths()
  return createMemo(() => {
    const directory = project.instance.path().directory || paths.cwd
    const name = path.basename(directory.replace(/[\\/]+$/, "") || directory) || directory
    if (sync.data.vcs?.branch) return `${name}:${sync.data.vcs.branch}`
    return name
  })
}
