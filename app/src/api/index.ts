/**
 * 与 Rust 后端的类型安全封装。
 *
 * 这是前端接触数据的**唯一入口**。规则：
 *   - 组件不直接调用 invoke，一律经这里
 *   - 不传递、不接收任何密钥材料
 *   - 不拼 SQL（后端只暴露预定义的业务操作，没有"执行任意 SQL"的接口）
 */

import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// 类型：与 Rust 侧结构一一对应
// ---------------------------------------------------------------------------

/** 后端错误。kind 是稳定的机器可读标识，请按它分支，不要解析 message 文本。 */
export interface AppErrorShape {
  kind:
    | "db"
    | "wrong_pin"
    | "locked"
    | "invalid_pin"
    | "crypto"
    | "io"
    | "state"
    | "validation";
  message: string;
  remainingSecs: number | null;
}

export interface AppStatus {
  initialized: boolean;
  unlocked: boolean;
  locked: boolean;
  remaining_lock_secs: number;
  remaining_attempts: number;
  show_hint: boolean;
  hint: string | null;
  pin_min_len: number;
  max_attempts: number;
  lockout_secs: number;
  data_dir: string;
}

export interface Entry {
  id: number;
  entry_date: string;
  title: string;
  content_md: string;
  word_count: number;
  mood: number | null;
  created_at: string;
  updated_at: string;
}

export interface EntrySummary {
  entry_date: string;
  title: string;
  word_count: number;
  mood: number | null;
  updated_at: string;
}

export interface SearchHit {
  entry_date: string;
  title: string;
  snippet: string;
  /** "word" = 精确词索引命中；"char" = 单字兜底索引命中（结果可能较宽泛） */
  matched_by: "word" | "char";
}

export interface Stats {
  total_entries: number;
  total_words: number;
  streak_days: number;
  first_date: string | null;
  last_date: string | null;
}

export interface BackupResult {
  path: string;
  bytes: number;
  created_at: number;
}

export interface IntegrityReport {
  entry_count: number;
  orphan_word_index: number;
  orphan_char_index: number;
  missing_word_index: number;
  missing_char_index: number;
}

export interface CryptoInfo {
  kdf: string;
  m_cost_mib: number;
  t_cost: number;
  p_cost: number;
}

// ---------------------------------------------------------------------------
// 错误处理
// ---------------------------------------------------------------------------

/**
 * 把 invoke 抛出的东西规范成 AppErrorShape。
 *
 * Tauri 会把 Rust 侧 Err 的序列化结果直接抛出，所以正常情况下它已经是
 * AppErrorShape。但网络/IPC 层也可能抛出字符串，这里统一兜底，
 * 避免组件里到处写类型判断。
 */
export function toAppError(e: unknown): AppErrorShape {
  if (e && typeof e === "object" && "kind" in e && "message" in e) {
    const shape = e as AppErrorShape;
    return { ...shape, remainingSecs: shape.remainingSecs ?? null };
  }
  return {
    kind: "state",
    message: typeof e === "string" ? e : "发生了未知错误",
    remainingSecs: null,
  };
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

export const getStatus = () => invoke<AppStatus>("app_status");

// ---------------------------------------------------------------------------
// 初始化 / 解锁 / 锁定
// ---------------------------------------------------------------------------

/**
 * 首次初始化：设置密码并创建加密数据库。
 *
 * hint 会**明文存储**并显示在锁屏界面（因为解锁前无法读取加密库），
 * 所以界面上要提示用户写得模糊一点。
 */
export const initializeVault = (pin: string, hint: string | null) =>
  invoke<void>("initialize_vault", { pin, hint });

export const unlockVault = (pin: string) =>
  invoke<AppStatus>("unlock_vault", { pin });

export const lockVault = () => invoke<AppStatus>("lock_vault");

// ---------------------------------------------------------------------------
// 日记读写
// ---------------------------------------------------------------------------

/**
 * 打开某天的日记。
 *
 * **不会写库**：没有内容时返回一条空模板（`id === 0`）。
 * 只有用户真正输入内容并触发保存，才会落库。
 *
 * 因此"打开过某天"不等于"写过某天" —— 后者由 isDateWritten 判定。
 */
export const openEntry = (date: string) =>
  invoke<Entry>("open_entry", { date });

/**
 * 某天是否**写过**（正文非空白）。
 *
 * 判定规则在后端集中一处（`db::HAS_CONTENT_SQL`），与日历标记、
 * 月度摘要、统计、搜索索引共用，避免多处判定漂移。
 */
export const isDateWritten = (date: string) =>
  invoke<boolean>("is_date_written", { date });

export const saveEntry = (date: string, title: string, contentMd: string) =>
  invoke<Entry>("save_entry", { date, title, contentMd });

export const deleteEntry = (date: string) =>
  invoke<void>("delete_entry", { date });

export const listMonth = (month: string) =>
  invoke<EntrySummary[]>("list_month", { month });

export const writtenDates = (from: string, to: string) =>
  invoke<string[]>("written_dates", { from, to });

export const getStats = () => invoke<Stats>("stats");

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

/**
 * 中文全文搜索。
 *
 * 后端会同时查两张索引并合并：jieba 词索引（精确）+ 单字索引（兜底）。
 * 所以搜「牛肉」也能搜到含「牛肉面」的日记 —— 后者由单字索引命中，
 * 此时 matched_by 为 "char"。
 */
export const searchEntries = (query: string, limit = 50) =>
  invoke<SearchHit[]>("search_entries", { query, limit });

// ---------------------------------------------------------------------------
// 维护
// ---------------------------------------------------------------------------

export const backupNow = (destDir: string) =>
  invoke<BackupResult>("backup_now", { destDir });

export const listBackups = (destDir: string) =>
  invoke<BackupResult[]>("list_backups", { destDir });

export const integrityCheck = () => invoke<IntegrityReport>("integrity_check");

export const rebuildIndexes = () => invoke<number>("rebuild_indexes");

export const cryptoInfo = () => invoke<CryptoInfo>("crypto_info");
