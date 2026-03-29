/**
 * 轮询主节点选举与租约续租
 */

import "server-only";

import {
  ensurePollerLeaseRow,
  getPollerLeaseSnapshot,
  tryAcquirePollerLease,
  tryRenewPollerLease,
} from "../database/poller-lease";
import {logError} from "../utils";
import {getPollerLeaderTimer, getPollerRole, setPollerLeaderTimer, setPollerRole, type PollerRole,} from "./global-state";

// 固定租约参数，不暴露环境变量
const LEASE_DURATION_MS = 120_000;
const LEASE_RENEW_INTERVAL_MS = 30_000;
const DEFAULT_NODE_ID = "local";
const FORCE_LEADER_ENV = "CHECK_POLLER_FORCE_LEADER";

let didWarnMissingNodeId = false;
let didWarnForceLeader = false;
let initPromise: Promise<void> | null = null;

function isForceLeaderEnabled(): boolean {
  const raw = process.env[FORCE_LEADER_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function resolveNodeId(): string {
  const raw = process.env.CHECK_NODE_ID?.trim();
  if (raw) {
    return raw;
  }

  const fallback = process.env.HOSTNAME?.trim() || DEFAULT_NODE_ID;
  if (!didWarnMissingNodeId) {
    console.warn(
      `[check-cx] 未设置 CHECK_NODE_ID，使用 ${fallback} 作为节点身份`
    );
    didWarnMissingNodeId = true;
  }
  return fallback;
}

const NODE_ID = resolveNodeId();

function isLeaseStillOwnedByCurrentNode(
  leaseExpiresAtIso: string,
  leaderId: string | null,
  nowMs: number
): boolean {
  if (leaderId !== NODE_ID) {
    return false;
  }
  const leaseExpiresAtMs = new Date(leaseExpiresAtIso).getTime();
  if (!Number.isFinite(leaseExpiresAtMs)) {
    return false;
  }
  return leaseExpiresAtMs > nowMs;
}

function setRole(nextRole: PollerRole): void {
  const currentRole = getPollerRole();
  if (currentRole === nextRole) {
    return;
  }
  setPollerRole(nextRole);
  console.log(
    `[check-cx] 节点角色切换：${currentRole} -> ${nextRole} (node=${NODE_ID})`
  );
}

async function refreshLeadership(): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LEASE_DURATION_MS);
  const nowMs = now.getTime();
  const currentRole = getPollerRole();

  if (currentRole === "leader") {
    const renewed = await tryRenewPollerLease(NODE_ID, now, expiresAt);
    if (!renewed) {
      const snapshot = await getPollerLeaseSnapshot();
      if (
        snapshot &&
        isLeaseStillOwnedByCurrentNode(
          snapshot.lease_expires_at,
          snapshot.leader_id,
          nowMs
        )
      ) {
        console.warn(
          `[check-cx] 续租返回未命中，但数据库显示租约仍由当前节点持有，继续保持 leader (node=${NODE_ID}, lease_expires_at=${snapshot.lease_expires_at})`
        );
        return;
      }
      setRole("standby");
      if (snapshot) {
        console.warn("[check-cx] leader 退位快照", {
          nodeId: NODE_ID,
          now: now.toISOString(),
          dbLeaderId: snapshot.leader_id,
          leaseExpiresAt: snapshot.lease_expires_at,
          updatedAt: snapshot.updated_at,
        });
      }
    }
    return;
  }

  const acquired = await tryAcquirePollerLease(NODE_ID, now, expiresAt);
  if (acquired) {
    setRole("leader");
    return;
  }

  const snapshot = await getPollerLeaseSnapshot();
  if (
    snapshot &&
    isLeaseStillOwnedByCurrentNode(
      snapshot.lease_expires_at,
      snapshot.leader_id,
      nowMs
    )
  ) {
    setRole("leader");
    console.warn(
      `[check-cx] 抢占租约未命中，但数据库显示当前节点仍持有有效租约，角色已修正为 leader (node=${NODE_ID}, lease_expires_at=${snapshot.lease_expires_at})`
    );
  }
}

export async function ensurePollerLeadership(): Promise<void> {
  if (isForceLeaderEnabled()) {
    setRole("leader");
    if (!didWarnForceLeader) {
      console.warn(
        `[check-cx] 已启用 ${FORCE_LEADER_ENV}，当前节点将跳过租约选主并始终作为 leader (node=${NODE_ID})`
      );
      didWarnForceLeader = true;
    }
    return Promise.resolve();
  }

  if (getPollerLeaderTimer()) {
    return initPromise ?? Promise.resolve();
  }
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    await ensurePollerLeaseRow();
    await refreshLeadership();
    const timer = setInterval(() => {
      refreshLeadership().catch((error) => {
        logError("pollerLeadership.refresh", error);
      });
    }, LEASE_RENEW_INTERVAL_MS);
    setPollerLeaderTimer(timer);
  })();

  return initPromise;
}

export function isPollerLeader(): boolean {
  return getPollerRole() === "leader";
}

export function getPollerNodeId(): string {
  return NODE_ID;
}
