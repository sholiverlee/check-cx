/**
 * Provider 检查统一入口
 */

import pLimit from "p-limit";
import type { CheckResult, ProviderConfig } from "../types";
import { getErrorMessage, getSanitizedErrorDetail, logError } from "../utils";
import { checkWithAiSdk } from "./ai-sdk-check";
import { getCheckConcurrency } from "../core/polling-config";

const MAX_429_RETRIES = 2;
const BASE_429_RETRY_DELAY_MS = 1_500;
const MAX_429_RETRY_DELAY_MS = 10_000;
const RETRY_JITTER_MS = 500;
const MIN_RETRY_DELAY_MS = 500;
const RATE_LIMIT_PATTERN = /(429|too many requests|rate limit|rate-limited)/i;

function isRateLimitedMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }
  return RATE_LIMIT_PATTERN.test(message);
}

function getRetryDelayMs(attempt: number): number {
  const exponential = Math.min(
    MAX_429_RETRY_DELAY_MS,
    BASE_429_RETRY_DELAY_MS * 2 ** attempt
  );
  const jitter =
    Math.floor(Math.random() * (RETRY_JITTER_MS * 2 + 1)) - RETRY_JITTER_MS;
  return Math.max(MIN_RETRY_DELAY_MS, exponential + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function checkProvider(config: ProviderConfig): Promise<CheckResult> {
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt += 1) {
    try {
      const result = await checkWithAiSdk(config);
      if (
        isRateLimitedMessage(result.message) &&
        attempt < MAX_429_RETRIES
      ) {
        const delayMs = getRetryDelayMs(attempt);
        console.warn(
          `[check-cx] ${config.name} 命中限流(429)，${delayMs}ms 后重试第 ${
            attempt + 2
          } 次`
        );
        await sleep(delayMs);
        continue;
      }
      return result;
    } catch (error) {
      const message = getErrorMessage(error);
      if (isRateLimitedMessage(message) && attempt < MAX_429_RETRIES) {
        const delayMs = getRetryDelayMs(attempt);
        console.warn(
          `[check-cx] ${config.name} 命中限流(429)，${delayMs}ms 后重试第 ${
            attempt + 2
          } 次`
        );
        await sleep(delayMs);
        continue;
      }
      logError(`检查 ${config.name} (${config.type}) 失败`, error);
      return {
        id: config.id,
        name: config.name,
        type: config.type,
        endpoint: config.endpoint,
        model: config.model,
        status: "error",
        latencyMs: null,
        pingLatencyMs: null,
        checkedAt: new Date().toISOString(),
        message,
        logMessage: getSanitizedErrorDetail(error),
        groupName: config.groupName || null,
      };
    }
  }

  throw new Error("Unexpected retry loop exit");
}

/**
 * 批量执行 Provider 健康检查
 * @param configs Provider 配置列表
 * @returns 检查结果列表,按名称排序
 */
export async function runProviderChecks(
  configs: ProviderConfig[]
): Promise<CheckResult[]> {
  if (configs.length === 0) {
    return [];
  }

  const limit = pLimit(getCheckConcurrency());
  const results = await Promise.all(
    configs.map((config) => limit(() => checkProvider(config)))
  );

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

// 导出统一检查函数
export { checkWithAiSdk } from "./ai-sdk-check";
