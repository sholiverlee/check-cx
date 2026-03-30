/**
 * 后台轮询器
 * 在应用启动时自动初始化并持续运行
 */

import {historySnapshotStore} from "../database/history";
import {loadProviderConfigsFromDB} from "../database/config-loader";
import {runProviderChecks} from "../providers";
import {getPollingIntervalMs, getPollingJitterMs} from "./polling-config";
import {getLastPingStartedAt, getPollerTimer, setLastPingStartedAt, setPollerTimer,} from "./global-state";
import {startOfficialStatusPoller} from "./official-status-poller";
import {ensurePollerLeadership, isPollerLeader} from "./poller-leadership";
import type {CheckResult, HealthStatus} from "../types";

const POLL_INTERVAL_MS = getPollingIntervalMs();
const POLL_JITTER_MS = getPollingJitterMs();
const STANDBY_LOG_INTERVAL_MS = 5 * 60 * 1000;
const MIN_EFFECTIVE_POLL_INTERVAL_MS = 1_000;
const FAILURE_STATUSES: ReadonlySet<HealthStatus> = new Set([
  "failed",
  "validation_failed",
  "error",
]);
let lastStandbyLogAt = 0;

function isFailureResult(result: CheckResult): boolean {
  return FAILURE_STATUSES.has(result.status);
}

function formatDuration(value: number | null): string {
  return typeof value === "number" ? `${value}ms` : "N/A";
}

function normalizeGroupName(groupName: string | null | undefined): string {
  return groupName?.trim() || "默认分组";
}

function logFullMessage(message: string): void {
  const normalizedMessage = message.replace(/\r\n/g, "\n");
  const lines = normalizedMessage.split("\n");

  for (const line of lines) {
    console.error(`[check-cx]     message: ${line}`);
  }
}

function logFailedResultsByGroup(results: CheckResult[]): void {
  const failedResults = results.filter(isFailureResult);
  if (failedResults.length === 0) {
    return;
  }

  const groupedResults = new Map<string, CheckResult[]>();
  for (const result of failedResults) {
    const groupName = normalizeGroupName(result.groupName);
    const items = groupedResults.get(groupName);
    if (items) {
      items.push(result);
      continue;
    }
    groupedResults.set(groupName, [result]);
  }

  console.error("[check-cx] ==================================================");
  console.error(
    `[check-cx] 本轮检测失败批次：共 ${failedResults.length} 条，分为 ${groupedResults.size} 组`
  );

  for (const [groupName, items] of [...groupedResults.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    console.error(`[check-cx] [${groupName}] ${items.length} 条`);

    for (const result of items.sort((left, right) => left.name.localeCompare(right.name))) {
      console.error(
        `[check-cx]   - ${result.name}(${result.type}/${result.model}) -> ${result.status} | latency=${formatDuration(
          result.latencyMs
        )} | ping=${formatDuration(result.pingLatencyMs)} | endpoint=${result.endpoint}`
      );

      const fullMessage = result.logMessage || result.message || "无";
      logFullMessage(fullMessage);
    }

    console.error("[check-cx] --------------------------------------------------");
  }

  console.error("[check-cx] ====================== 批次结束 =====================");
}

function getNextPollDelayMs(): number {
  if (POLL_JITTER_MS <= 0) {
    return POLL_INTERVAL_MS;
  }
  const offsetMs = Math.floor(Math.random() * (POLL_JITTER_MS * 2 + 1)) - POLL_JITTER_MS;
  return Math.max(MIN_EFFECTIVE_POLL_INTERVAL_MS, POLL_INTERVAL_MS + offsetMs);
}

function scheduleNextTick(): void {
  const delayMs = getNextPollDelayMs();
  const nextAt = new Date(Date.now() + delayMs).toISOString();
  const timer = setTimeout(() => {
    tick()
      .catch((error) => console.error("[check-cx] 定时检测失败", error))
      .finally(() => {
        scheduleNextTick();
      });
  }, delayMs);
  setPollerTimer(timer);
  console.log(`[check-cx] 下一轮轮询预计 ${nextAt}（delay=${delayMs}ms）`);
}

/**
 * 执行一次轮询检查
 */
async function tick() {
  const tickStartedAt = Date.now();
  try {
    await ensurePollerLeadership();
  } catch (error) {
    console.error("[check-cx] 主节点选举失败，跳过本轮轮询", error);
    return;
  }
  if (!isPollerLeader()) {
    const now = Date.now();
    if (now - lastStandbyLogAt >= STANDBY_LOG_INTERVAL_MS) {
      console.log("[check-cx] 跳过本轮轮询：当前节点为 standby（非 leader）");
      lastStandbyLogAt = now;
    }
    return;
  }
  // 原子操作：检查并设置运行状态
  if (globalThis.__checkCxPollerRunning) {
    const lastStartedAt = getLastPingStartedAt();
    const duration = lastStartedAt ? Date.now() - lastStartedAt : null;
    console.log(
      `[check-cx] 跳过 ping：上一轮仍在执行${
        duration !== null ? `（已耗时 ${duration}ms）` : ""
      }`
    );
    return;
  }
  globalThis.__checkCxPollerRunning = true;

  setLastPingStartedAt(Date.now());
  console.log(`[check-cx] 开始执行轮询检测 (${new Date(tickStartedAt).toISOString()})`);
  try {
    const allConfigs = await loadProviderConfigsFromDB();
    // 过滤掉维护中的配置
    const configs = allConfigs.filter((cfg) => !cfg.is_maintenance);

    if (configs.length === 0) {
      const duration = Date.now() - tickStartedAt;
      console.log(`[check-cx] 本轮轮询结束：未找到可检测配置（耗时 ${duration}ms）`);
      return;
    }

    const results = await runProviderChecks(configs);
    await historySnapshotStore.append(results);
    logFailedResultsByGroup(results);
    const duration = Date.now() - tickStartedAt;
    console.log(
      `[check-cx] 本轮轮询结束：检测 ${configs.length} 个配置，写入 ${results.length} 条结果（耗时 ${duration}ms）`
    );
  } catch (error) {
    console.error("[check-cx] 轮询检测失败", error);
  } finally {
    globalThis.__checkCxPollerRunning = false;
  }
}

// 自动初始化轮询器
if (!getPollerTimer()) {
  const firstDelayMs = getNextPollDelayMs();
  const firstCheckAt = new Date(Date.now() + firstDelayMs).toISOString();
  console.log(
    `[check-cx] 初始化后台轮询器，interval=${POLL_INTERVAL_MS}ms，jitter=±${POLL_JITTER_MS}ms，首次检测预计 ${firstCheckAt}`
  );
  ensurePollerLeadership().catch((error) => {
    console.error("[check-cx] 初始化主节点选举失败", error);
  });
  const timer = setTimeout(() => {
    tick()
      .catch((error) => console.error("[check-cx] 定时检测失败", error))
      .finally(() => {
        scheduleNextTick();
      });
  }, firstDelayMs);
  setPollerTimer(timer);

  // 启动官方状态轮询器
  startOfficialStatusPoller();
}
