/**
 * Gemini 官方状态检查器
 * 状态 API: https://status.cloud.google.com/incidents.json
 */

import type {OfficialHealthStatus, OfficialStatusResult} from "../types";
import {logError} from "../utils/error-handler";

const GEMINI_STATUS_URL = "https://status.cloud.google.com/incidents.json";
const TIMEOUT_MS = 15000; // 15 秒超时

interface GoogleStatusIncidentProduct {
  id?: string;
  title?: string;
}

interface GoogleStatusIncident {
  begin?: string;
  end?: string | null;
  external_desc?: string;
  severity?: string;
  status_impact?: string;
  affected_products?: GoogleStatusIncidentProduct[];
}

const GEMINI_PRODUCT_KEYWORDS = ["gemini", "generative ai"];

/**
 * 检查 Gemini 官方服务状态
 */
export async function checkGeminiStatus(): Promise<OfficialStatusResult> {
  const checkedAt = new Date().toISOString();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(GEMINI_STATUS_URL, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        status: "unknown",
        message: `HTTP ${response.status}`,
        checkedAt,
      };
    }

    const data = (await response.json()) as unknown;
    return parseGeminiStatus(data, checkedAt);
  } catch (error) {
    logError("checkGeminiStatus", error);

    if ((error as Error).name === "AbortError") {
      return {
        status: "unknown",
        message: "检查超时",
        checkedAt,
      };
    }

    return {
      status: "unknown",
      message: "检查失败",
      checkedAt,
    };
  }
}

function parseGeminiStatus(
  data: unknown,
  checkedAt: string
): OfficialStatusResult {
  if (!Array.isArray(data)) {
    return {
      status: "unknown",
      message: "状态数据格式异常",
      checkedAt,
    };
  }

  const incidents = data as GoogleStatusIncident[];
  const geminiIncidents = incidents.filter(isGeminiIncident);
  const activeGeminiIncidents = geminiIncidents.filter(isActiveIncident);

  if (activeGeminiIncidents.length === 0) {
    return {
      status: "operational",
      message: "所有系统正常运行",
      checkedAt,
    };
  }

  const affectedComponents = collectAffectedProducts(activeGeminiIncidents);
  const status = deriveHealthStatus(activeGeminiIncidents);
  const message = buildStatusMessage(activeGeminiIncidents, affectedComponents);

  return {
    status,
    message,
    checkedAt,
    affectedComponents:
      affectedComponents.length > 0 ? affectedComponents : undefined,
  };
}

function isGeminiIncident(incident: GoogleStatusIncident): boolean {
  const products = incident.affected_products ?? [];

  if (products.length === 0) {
    return false;
  }

  return products.some((product) => {
    const title = (product.title || "").toLowerCase();
    return GEMINI_PRODUCT_KEYWORDS.some((keyword) => title.includes(keyword));
  });
}

function isActiveIncident(incident: GoogleStatusIncident): boolean {
  const now = Date.now();
  const beginMs = Date.parse(incident.begin || "");

  if (Number.isNaN(beginMs) || beginMs > now) {
    return false;
  }

  if (!incident.end) {
    return true;
  }

  const endMs = Date.parse(incident.end);
  if (Number.isNaN(endMs)) {
    return false;
  }

  return endMs > now;
}

function collectAffectedProducts(incidents: GoogleStatusIncident[]): string[] {
  const result = new Set<string>();

  incidents.forEach((incident) => {
    (incident.affected_products ?? []).forEach((product) => {
      if (product.title) {
        result.add(product.title);
      }
    });
  });

  return Array.from(result);
}

function deriveHealthStatus(incidents: GoogleStatusIncident[]): OfficialHealthStatus {
  let status: OfficialHealthStatus = "degraded";

  for (const incident of incidents) {
    const severity = (incident.severity || "").toLowerCase();
    const impact = (incident.status_impact || "").toUpperCase();
    const description = (incident.external_desc || "").toLowerCase();

    const isDown =
      severity.includes("high") ||
      severity.includes("critical") ||
      impact.includes("OUTAGE") ||
      impact.includes("DOWN") ||
      description.includes("outage") ||
      description.includes("down");

    if (isDown) {
      status = "down";
      break;
    }
  }

  return status;
}

function buildStatusMessage(
  incidents: GoogleStatusIncident[],
  affectedComponents: string[]
): string {
  if (affectedComponents.length > 0) {
    const shortList = affectedComponents.slice(0, 3).join(", ");
    const suffix =
      affectedComponents.length > 3
        ? ` 等 ${affectedComponents.length} 个组件`
        : "";
    return `${shortList}${suffix} 受影响`;
  }

  const fallback = incidents[0]?.external_desc?.trim();
  return fallback || "检测到 Gemini 服务异常";
}
