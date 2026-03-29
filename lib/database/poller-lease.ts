/**
 * 轮询主节点租约管理
 */

import "server-only";
import type {PostgrestError} from "@supabase/supabase-js";

import {createAdminClient} from "../supabase/admin";
import {logError} from "../utils";

const LEASE_TABLE = "check_poller_leases";
const LEASE_KEY = "poller";
const INITIAL_LEASE_EXPIRES_AT = new Date(0).toISOString();

export interface PollerLeaseSnapshot {
  lease_key: string;
  leader_id: string | null;
  lease_expires_at: string;
  updated_at: string;
}

function isDuplicateKeyError(error: PostgrestError | null): boolean {
  return error?.code === "23505";
}

export async function ensurePollerLeaseRow(): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from(LEASE_TABLE).insert({
    lease_key: LEASE_KEY,
    leader_id: null,
    lease_expires_at: INITIAL_LEASE_EXPIRES_AT,
  });

  if (error && !isDuplicateKeyError(error)) {
    logError("初始化轮询租约失败", error);
  }
}

export async function tryAcquirePollerLease(
  nodeId: string,
  now: Date,
  expiresAt: Date
): Promise<boolean> {
  const supabase = createAdminClient();
  const nowIso = now.toISOString();
  const { data, error } = await supabase
    .from(LEASE_TABLE)
    .update({
      leader_id: nodeId,
      lease_expires_at: expiresAt.toISOString(),
      updated_at: nowIso,
    })
    .eq("lease_key", LEASE_KEY)
    .lt("lease_expires_at", nowIso)
    .select("lease_key");

  if (error) {
    logError("获取轮询租约失败", error);
    console.error("[check-cx] 获取轮询租约失败详情", {
      nodeId,
      nowIso,
      expiresAt: expiresAt.toISOString(),
    });
    return false;
  }

  return Array.isArray(data) && data.length > 0;
}

export async function tryRenewPollerLease(
  nodeId: string,
  now: Date,
  expiresAt: Date
): Promise<boolean> {
  const supabase = createAdminClient();
  const nowIso = now.toISOString();
  const { data, error } = await supabase
    .from(LEASE_TABLE)
    .update({
      lease_expires_at: expiresAt.toISOString(),
      updated_at: nowIso,
    })
    .eq("lease_key", LEASE_KEY)
    .eq("leader_id", nodeId)
    .gt("lease_expires_at", nowIso)
    .select("lease_key");

  if (error) {
    logError("续租轮询租约失败", error);
    console.error("[check-cx] 续租轮询租约失败详情", {
      nodeId,
      nowIso,
      expiresAt: expiresAt.toISOString(),
    });
    return false;
  }

  return Array.isArray(data) && data.length > 0;
}

export async function getPollerLeaseSnapshot(): Promise<PollerLeaseSnapshot | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from(LEASE_TABLE)
    .select("lease_key, leader_id, lease_expires_at, updated_at")
    .eq("lease_key", LEASE_KEY)
    .maybeSingle();

  if (error) {
    logError("读取轮询租约快照失败", error);
    return null;
  }

  if (!data) {
    return null;
  }

  return data as PollerLeaseSnapshot;
}
