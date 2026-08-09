import * as vscode from "vscode"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  buildManthanConfigContent,
  formatStatusBar,
  parseSessionListForManthan,
  type ManthanContextSnap,
  type ManthanSettings,
} from "./manthan-config"

export type { ManthanContextSnap, ManthanSettings }
export { buildManthanConfigContent, formatStatusBar }

export function readManthanSettings(): ManthanSettings {
  const cfg = vscode.workspace.getConfiguration("manthan")
  return {
    baseUrl: (cfg.get<string>("baseUrl") || "http://127.0.0.1:3000/v1").replace(/\/$/, ""),
    apiKey: cfg.get<string>("apiKey") || process.env.MANTHAN_API_KEY || "",
    model: cfg.get<string>("model") || "manthan/laguna-xs-2.1-sharded",
    binary: cfg.get<string>("binary") || "opencode",
    showPowerFields: cfg.get<boolean>("showPowerFields") === true,
  }
}

export function writeTempManthanConfig(settings: ManthanSettings): string {
  const dir = path.join(os.tmpdir(), "manthan-opencode")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `opencode-manthan-${process.pid}.json`)
  fs.writeFileSync(file, buildManthanConfigContent(settings), "utf8")
  return file
}

export async function manthanHealthCheck(settings: ManthanSettings): Promise<string> {
  const url = settings.baseUrl.replace(/\/v1\/?$/, "") + "/v1/models"
  const headers: Record<string, string> = { Accept: "application/json" }
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`Manthan health failed: HTTP ${res.status} (${url})`)
  const body = (await res.json()) as { data?: unknown[]; models?: unknown[] }
  const n = Array.isArray(body.data) ? body.data.length : Array.isArray(body.models) ? body.models.length : 0
  return `Manthan OK — ${n} model(s) at ${settings.baseUrl}`
}

export async function fetchManthanContextFromCli(
  port: number,
  directory?: string,
): Promise<ManthanContextSnap | null> {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (directory) headers["x-opencode-directory"] = directory
  const res = await fetch(`http://127.0.0.1:${port}/session?limit=20`, { headers })
  if (!res.ok) return null
  return parseSessionListForManthan(await res.json())
}
