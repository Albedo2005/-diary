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
  /** 锁定：true = 只读不可改。锁的是内容，排版原样保留。 */
  locked: boolean;
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

/** 某天的心情标记。日历用它显示表情；没标心情的日子不会出现在结果里。 */
export interface DayMood {
  entry_date: string;
  /** 1=悲伤 2=受伤 3=茫然 4=愤怒 5=开心（1~5 只是编号，无好坏顺序） */
  mood: number;
}

/**
 * 心情档位：数值 → 显示。
 *
 * 数值含义是**前后端契约的一部分**（后端就存 1~5），emoji 只是它的展示形式。
 * 放在这里而不是各组件里各写一份：编辑器的按钮和日历格子上的小表情
 * 必须共用同一张表，否则迟早出现"编辑器标的是开心、日历显示受伤"。
 *
 * ⚠️ 1~5 **只是编号**，不是"由差到好"的程度刻度 ——
 *    五种心情是并列的类型，谁也不比谁"更高级"，别按顺序去理解或排序。
 *    将来要加档就**往后编号**，不要插在中间：插入会让已存进库的
 *    历史数据整体错位（昨天标的 😡 会突然变成别的情绪）。
 */
export const MOODS = [
  { value: 1, emoji: "😭", label: "悲伤" },
  { value: 2, emoji: "🤕", label: "受伤" },
  { value: 3, emoji: "😶‍🌫️", label: "茫然" },
  { value: 4, emoji: "😡", label: "愤怒" },
  { value: 5, emoji: "🥰", label: "开心" },
] as const;

/** 数值 → emoji 查表。日历按数值取表情时用它。 */
export const MOOD_EMOJI: Record<number, string> = Object.fromEntries(
  MOODS.map((m) => [m.value, m.emoji])
);

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

/** 备份相关状态，供界面展示。 */
export interface BackupStatus {
  /** 备份目录（数据目录下的 backups 子目录）。 */
  dest_dir: string;
  /** 自动备份是否开启。默认开启。 */
  auto_enabled: boolean;
  /** 距下次自动备份还有多少秒。0 表示很快执行。 */
  secs_until_next: number;
  /** 备份间隔（秒）。 */
  interval_secs: number;
  /** 保留的最近份数。 */
  keep_recent: number;
  /** 已有备份数量。 */
  backup_count: number;
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

/** 应用设置。与后端 `db::AppSettings` 一一对应。 */
export interface AppSettings {
  /** 窗口失去焦点后多久自动锁定（秒）。`0` = 永不。 */
  auto_lock_secs: number;
}

/**
 * 自动锁定时长的档位。**白名单**，与后端 `db::AUTO_LOCK_ALLOWED_SECS` 一一对应。
 *
 * 为什么钉死四档而不是让用户填任意秒数：这个值决定"离开多久之后
 * 密钥从内存里消失"，是安全参数。放开成任意值，一定有人填 3 秒
 * （自己被烦死）或 8 小时（等于没设），最后等于不用自动锁定。
 *
 * ⚠️ `0` = 永不，是**合法档位**，不要当"没设置"处理。
 */
export const AUTO_LOCK_OPTIONS = [
  { value: 60, label: "1 分钟" },
  { value: 300, label: "5 分钟" },
  { value: 600, label: "10 分钟" },
  { value: 0, label: "永不" },
] as const;

/** 默认档位：10 分钟。与后端 `db::DEFAULT_AUTO_LOCK_SECS` 保持一致。 */
export const DEFAULT_AUTO_LOCK_SECS = 600;

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

/**
 * 保存日记。
 *
 * `mood`：1=悲伤 2=受伤 3=茫然 4=愤怒 5=开心（1~5 只是编号，无好坏顺序），
 * `null` = 未标记。档位与 emoji 的对照见下方 `MOODS`。
 * 心情与正文**同一次写入**：正文为空时后端会丢掉心情，
 * 所以不存在"有心情但没内容"的记录（见 db.rs 的 save_entry_with_mood）。
 */
export const saveEntry = (
  date: string,
  title: string,
  contentMd: string,
  mood: number | null
) => invoke<Entry>("save_entry", { date, title, contentMd, mood });

/** 锁定 / 解锁某天。只改"能否修改"，不动正文。 */
export const setEntryLocked = (date: string, locked: boolean) =>
  invoke<Entry>("set_entry_locked", { date, locked });

/** 一次性锁上所有日记。切换日期、重新打开软件时调用。返回被锁的篇数。 */
export const lockAllEntries = () => invoke<number>("lock_all_entries");

export const deleteEntry = (date: string) =>
  invoke<void>("delete_entry", { date });

export const listMonth = (month: string) =>
  invoke<EntrySummary[]>("list_month", { month });

export const writtenDates = (from: string, to: string) =>
  invoke<string[]>("written_dates", { from, to });

/**
 * 区间内**有心情标记**的日期与心情值。
 *
 * 与 writtenDates 分开取：那个回答"这天写过没"，这个回答"这天标了什么心情"。
 * 日历用它在日期格上显示表情（第三种标记）。
 */
export const writtenMoods = (from: string, to: string) =>
  invoke<DayMood[]>("written_moods", { from, to });

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

/** 备份状态：目录、是否自动、距下次多长时间、已有几份。 */
export const getBackupStatus = () => invoke<BackupStatus>("backup_status");

/** 开关自动备份。默认开启 —— 对日记来说"忘了开备份"等于"没有备份"。 */
export const setAutoBackup = (enabled: boolean) =>
  invoke<void>("set_auto_backup", { enabled });

export const listBackups = (destDir: string) =>
  invoke<BackupResult[]>("list_backups", { destDir });

export const integrityCheck = () => invoke<IntegrityReport>("integrity_check");

export const rebuildIndexes = () => invoke<number>("rebuild_indexes");

export const cryptoInfo = () => invoke<CryptoInfo>("crypto_info");

// ---------------------------------------------------------------------------
// 应用设置
// ---------------------------------------------------------------------------

/**
 * 读取应用设置。
 *
 * 后端刻意**不报错**：缺失 / 解析失败 / 值不在白名单，一律回落默认值 ——
 * 1.6 及之前的库根本没有 `auto_lock_secs` 这个 key，报错会让升级上来的
 * 库一打开就失败，而用户什么都没做错。
 *
 * ⚠️ 这些值**不能**从 `app_status` 拿：`app_setting` 表在加密库里，
 *    未解锁时读不到；硬塞进 status 只会编出一个默认值来骗界面。
 *    （只有解锁后才调得动这条命令。）
 */
export const getSettings = () => invoke<AppSettings>("get_settings");

/**
 * 设置自动锁定时长（秒）。只接受 `AUTO_LOCK_OPTIONS` 里的四个档位，
 * 其他值后端返回 `validation` 错误。
 *
 * 写入失败时**必须把界面回滚成原值** —— 别本地改完就当成功。
 */
export const setAutoLockSecs = (secs: number) =>
  invoke<void>("set_auto_lock_secs", { secs });
