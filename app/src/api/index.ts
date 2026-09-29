/**
 * 与 Rust 后端的类型安全封装。
 *
 * 这是前端接触数据的**唯一入口**。规则：
 *   - 组件不直接调用 invoke，一律经这里
 *   - 不传递、不接收任何密钥材料
 *   - 不拼 SQL（后端只暴露预定义的业务操作，没有"执行任意 SQL"的接口）
 */

import { invoke } from "@tauri-apps/api/core";
import { todayKey } from "../utils/date";

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
  /**
   * 是否开启了免密打开（`data/auto_login.json` 是否存在）。
   *
   * ⚠️ 这个字段读的是**库外文件**，所以未解锁时也是准的 ——
   *    启动流程正是靠它决定"走不走免密"。它不是加密库里的设置项。
   */
  auto_login: boolean;
  data_dir: string;
  /**
   * 「导出全部日记」输入框的默认值（数据目录同级的 `导出/`）。
   *
   * 规则住在后端（`commands::default_export_dir`），这里只拿来预填输入框 ——
   * 前端不要自己拼一份，否则两处各算各的、迟早对不上。
   */
  export_default_dir: string;
  /**
   * 图片附件的缓存目录（`<数据目录>/attachments/`）。
   *
   * 设置页【数据与备份】用它显示「图片缓存位置」，并配一个「打开文件夹」。
   * 附件是**明文**文件（用户已知风险），所以位置必须让用户看得见。
   */
  attachments_dir: string;
  /**
   * 「后悔药」目录（`<数据目录>/backups/pre-restore/`）。
   *
   * 每次恢复备份前，软件会把**当前这份库**连同 meta 一起快照到这里。
   * 恢复确认弹窗要把它原样写出来（并配「打开文件夹」）—— 那是用户按下
   * "替换"之前最后想知道的一件事。
   *
   * 与 `export_default_dir` 同理：规则住在后端，前端不要自己拼路径。
   */
  pre_restore_dir: string;
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

/**
 * 一个标签 + 它的使用情况。
 *
 * `entry_count` 只数**写过**的日记（后端用与日历标记、统计同一条
 * `has_content_sql()` 判定），所以它可能与"某天挂过这个标签"的次数不一致。
 *
 * **可能是 0**：把最后一篇带它的日记的标签撤掉之后，标签本身不会自动消失。
 * 界面上要如实显示"0 篇"，不要隐藏 —— 藏起来用户就没机会删它了。
 */
export interface TagStat {
  id: number;
  name: string;
  entry_count: number;
}

export interface SearchHit {
  entry_date: string;
  title: string;
  snippet: string;
  /** "word" = 精确词索引命中；"char" = 单字兜底索引命中（结果可能较宽泛） */
  matched_by: "word" | "char";
}

/**
 * 筛选页的一条结果（P2-7）。
 *
 * ⚠️ 这份是**手抄 Rust 侧 `db::FilterHit`** 的，加字段必须**两边同时改** ——
 *    漏了不会编译报错，只会在运行时读到 `undefined`。
 */
export interface FilterHit {
  entry_date: string;
  /**
   * 1~5。没标心情时是 `null`。
   * ⚠️ 五个值是**并列的编号，不是刻度** ⇒ 界面上**不许**按"好坏"排序或写"更好的心情"。
   */
  mood: number | null;
  /**
   * 第二行要显示的那段字，**后端已经拼好了**：
   *   * 有正文 → 正文开头约 60 字
   *   * 纯图片日记 → `〔这一篇有 N 张图片〕`
   * ⛔ 前端**直接显示**，别再自己判断"预览为空意味着纯图片" ——
   *    那个判断在后端一处（P2-3 富文本落地时只改那边）。
   */
  line: string;
  /** 这一篇上挂的标签名（已按名字排序，**含已退休的**）。空数组＝什么都不显示。 */
  tags: string[];
}

/** 筛选的完整结果（P2-7）。 */
export interface FilterResult {
  hits: FilterHit[];
  /**
   * **符合条件的一共有多少篇**（不受 `limit` 影响）。
   * ⚠️ 界面那句"只显示前 N 条"要不要出现，看它 —— 别拿 `hits.length === limit` 去猜：
   *    恰好等于上限时那句话就成了谎话。
   */
  total: number;
  /** 这次生效的上限（后端 clamp 过，1~500）。那句话里的数字从这里来，⛔ 别写死 200。 */
  limit: number;
}

/** 一个心情档位的出现次数。后端只返回**出现过**的档位。 */
export interface MoodCount {
  mood: number;
  count: number;
}

/** 某个月的总字数。 */
export interface MonthWords {
  /** `YYYY-MM` */
  month: string;
  words: number;
}

/**
 * 统计面板要用的全部数字，**一条命令取齐**（`getStats()`）。
 *
 * ⚠️ 这份是手抄 Rust 侧 `db::Stats` 的，加字段必须**两边同时改** ——
 *    漏了不会编译报错，只会在运行时读到 `undefined`。
 */
export interface Stats {
  total_entries: number;
  total_words: number;
  /**
   * **当前连续**：以"最新写过的那一天"收尾的那一段天数。
   *
   * ⚠️ 口径是"从最近一篇往前逐日相接"，**不是"必须写到今天"**：
   *    今天还没写、昨天写了，仍显示到昨天为止（用户 2026-09-21 拍板）。
   *    所以界面上要标注"截至 {last_date}"，否则用户会以为今天是断的。
   */
  streak_days: number;
  first_date: string | null;
  last_date: string | null;
  /** **最长连续**：历史纪录。断一天再写，上面那个归 1，这里保留。 */
  longest_streak: number;
  /** 本周（**周一起算**）写过几天。 */
  days_this_week: number;
  /** 本月写过几天。 */
  days_this_month: number;
  /** 各档位的出现次数。没出现过的档位不在里面，展示时按 `MOODS` 补 0。 */
  mood_counts: MoodCount[];
  /** 每月字数，按月份升序。没有内容的月份不出现，画图时自己补空位。 */
  monthly_words: MonthWords[];
  /** 热力图窗口的第一天。**一定是周一**。 */
  heatmap_start: string;
  /** 热力图窗口的最后一天（含）。**一定是周日**，且 ≥ today。 */
  heatmap_end: string;
  /**
   * 窗口内"写过"的每一天，按日期升序。
   *
   * ⚠️ **没写过的日子不在里面** —— 正是靠这一点区分"没写"与"写了 0 字"：
   *    窗口内、但不在这份名单里 ＝ 没写（画灰格）。
   *    "写了 0 字"（只有图片的日记）**在名单里**、`words === 0`，画最浅那一档绿。
   * ⚠️ 窗口之外的历史不返回 —— 热力图画的是"这一年"。
   */
  daily_words: DayWords[];
}

/**
 * 热力图窗口内**写过**的某一天。
 *
 * ⚠️ 这份 interface 是**手抄** Rust 侧 `db.rs` 的 `DayWords`（本文件上面有说明：
 *    漏抄不会编译报错，只会在运行时读到 `undefined`）。加字段要两边同时改。
 */
export interface DayWords {
  /** `YYYY-MM-DD` */
  date: string;
  /** 这一天写了多少字。**可能是 0** —— 只有图片、没有文字的日记也算"写过"。 */
  words: number;
}

// ---------------------------------------------------------------------------
// 「回顾」（P2-23）
// ---------------------------------------------------------------------------

/**
 * 一整天的"最小信息"，给「回顾」里那些卡片用。
 *
 * ⚠️ 手抄 Rust 侧 `db::DayDigest` 的（同 `Stats` 的说明：漏抄不会编译报错，
 *    只会在运行时读到 `undefined`）。加字段要两边同时改。
 */
export interface DayDigest {
  /** `YYYY-MM-DD` */
  date: string;
  /** `null` ＝ 那天没标心情。档位对照见 `MOODS`。 */
  mood: number | null;
  /** 直接来自后端的 `entry.word_count` 列。⛔ 前端不自己数。 */
  words: number;
  /** 正文开头一小段。**由后端的 `make_preview()` 生成** —— P2-3 落地后只改那一处。 */
  preview: string;
}

/** 「照片最多的一篇」。 */
export interface PhotoTop {
  date: string;
  photos: number;
}

/** 「最长连续同一种心情」。五种心情是**并列的类型，不是刻度**。 */
export interface MoodStreak {
  mood: number;
  days: number;
  /** 起止**都是真实写过的日期**（不是按天数推算的）。 */
  from: string;
  to: string;
}

/**
 * 「回顾」那一屏的全部数据（`getRecap()`）。
 *
 * ⚠️ 手抄 Rust 侧 `db::Recap` 的，加字段要两边同时改。
 */
export interface Recap {
  /** 写得最长的一篇。库里只有纯图片日记时为 `null`。 */
  longest_entry: DayDigest | null;
  /** 照片最多的一篇。一张图都没有时为 `null`。 */
  most_photos: PhotoTop | null;
  /** 最长连续同一种心情。从没标过心情时为 `null`。 */
  mood_streak: MoodStreak | null;
  /**
   * **所有写过的日子**（含纯图片日），按日期升序。
   *
   * ⚠️ 这里**不判"往年今天"是哪几天** —— 那句判定在 `utils/date.ts` 的
   *    `sameDayInPastYears()`，全项目只有一份实现。前端先用它把要显示的那几天
   *    筛出来，再回来这份名单里取内容（所以这里给的是全部，不是筛过的结果）。
   */
  days: DayDigest[];
}

export interface BackupResult {
  path: string;
  bytes: number;
  created_at: number;
}

/** Markdown 导出结果。 */
export interface ExportResult {
  /** 实际写入的目录（已归一化成绝对路径，可能带重名后缀）。 */
  dest_dir: string;
  /** 导出了多少篇。口径与统计的"共 N 篇"一致 —— 只数**写过**的。 */
  entry_count: number;
  /** 因目标文件已存在而被加后缀的次数（首次导出到空目录为 0）。 */
  renamed: number;
  /** `index.md` 的落盘路径（可能带后缀）。 */
  index_path: string;
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

/** 一份备份的体检报告（对应后端 `commands::BackupInfo`）。恢复前的确认弹窗用它。 */
export interface BackupInfo {
  /** 备份主文件（`.db`）的完整路径。 */
  db_path: string;
  /** 配对的 `.meta.json` 的完整路径。 */
  meta_path: string;
  /** 配对的 meta 在不在。**false ＝ 这份备份永远打不开。** */
  meta_found: boolean;
  bytes: number;
  /** 备份时间（Unix 秒）。优先来自**文件名**，不是文件的修改时间。 */
  created_at: number;
  /** 备份里的篇数。`null` ＝ 读不出来（**后端不会编一个数**）。 */
  entry_count: number | null;
  /** 用当前这把钥匙能不能打开它。 */
  openable_now: boolean;
  /**
   * 此刻手里**有没有**可用的钥匙去判断上面那两项。
   *
   * ⚠️ 必须与 `entry_count === null` 分开用：前者是"我们不知道"
   *    （没开免密、库也锁着），后者是"它不是用你现在的密码加密的"。
   *    界面上混成一句话，用户会以为自己密码记错了。
   */
  key_available: boolean;
}

/** 「复制备份到…」的结果。 */
export interface CopyBackupsResult {
  /** 复制过去的文件个数（含 `pre-restore/` 里的）。 */
  copied: number;
  bytes: number;
  /** 实际写入的目录（已规范化，便于界面如实回显"写到哪了"）。 */
  dest_dir: string;
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
  /**
   * 离开某一天时（切日期 / 重开软件）是否自动把日记锁上。默认 `true`。
   *
   * ⚠️ 与 `auto_lock_secs` **同名不同义**：那个锁的是**整个应用**
   *    （回解锁页），这个锁的是**单篇日记**（那天的正文变只读）。
   */
  auto_lock_entries: boolean;
  /**
   * 日记锁定时，在正文里连点三下左键是否可以直接解锁（指令 15）。默认 `true`。
   *
   * ⚠️ 只决定"这个手势要不要开"，**不改变任何锁定语义**：
   *    关掉后手动 🔒 / 🔓 按钮照旧好用。
   */
  triple_click_unlock: boolean;
  /**
   * 点窗口 `✕` 时做什么（【P2-21】）。
   *
   * ⚠️ 它与下面 `CloseAction` 那两个值是**同一套**，别另立字符串。
   */
  close_action: CloseAction;
  /**
   * 写作提醒是否开启（【P2-13】）。默认 `false`。
   *
   * ⚠️ 默认关是**用户拍板的**：提醒会让窗口自己跳出来，这种事必须他亲手开。
   */
  reminder_enabled: boolean;
  /** 提醒的重复策略（【P2-13】）。默认 `"daily"`。见 `ReminderMode`。 */
  reminder_mode: ReminderMode;
  /**
   * 提醒时间，**洗净后**的 `"HH:MM"`（两位补零）。默认 `"21:00"`。
   *
   * ⚠️ 后端保证它一定是 `HH:MM`：前端可以直接拿它跟"现在的 HH:MM"
   *    做**字符串比较**（定长字符串的字典序就是时间序），别再解析一遍。
   */
  reminder_time: string;
  /**
   * 最后一次真的响过提醒的日期（`YYYY-MM-DD`）；从没响过是**空串**。
   *
   * ⚠️ 它落盘是刻意的：`daily` 档承诺"一天一次"，只存内存的话
   *    重启一次软件当天就会再响一次。
   */
  reminder_last_fired: string;
  /** 开机自启（【P2-13】）。默认 `false`。 */
  auto_start: boolean;
  /**
   * 每日字数目标（【P2-12】）。`0` ＝ **不用这个功能**。
   *
   * ⚠️ 它是**设置**，不是内容：不进 `entry` 表、不落 `localStorage`。
   * ⚠️ 只在看**今天**时用它 —— 翻到别的日子显示目标会让人误读成
   *    "这天只写了这么点"。
   */
  daily_word_goal: number;
}

/**
 * 点窗口 `✕` 时做什么（【P2-21】）。与后端 `db::CloseAction` 一一对应。
 *
 * ⚠️ **只有两个值** —— "用户从没设置过"**不是**第三个值：
 *    那种情况后端会自己推导（跟提醒走：提醒开着 ⇒ 最小化到托盘），
 *    前端看到的**永远是推导之后的结果**，不需要知道"设过没有"。
 */
export type CloseAction = "tray" | "quit";

/**
 * 提醒的重复策略（【P2-13】）。与后端 `db::ReminderMode` 一一对应。
 *
 * - `daily`   到点响一次；当天不再响（**重启也不再响**）。出厂默认。
 * - `on_open` 不看到点：**软件一启动**就判断一次，当天还没写就提。
 * - `never`   不提醒。
 *
 * ⚠️ 它与"提醒总开关"是**两件事**：开关管"要不要提醒"，
 *    这一档管"报到的节奏"。开关关着时，三档一个都不生效。
 */
export type ReminderMode = "daily" | "on_open" | "never";

/**
 * 三档的选项。文案就是用户看到的文案。
 *
 * ⚠️ 顺序固定：`daily` 在前（出厂默认）。
 */
export const REMINDER_MODE_OPTIONS: { value: ReminderMode; label: string }[] = [
  { value: "daily", label: "一天提醒一次" },
  { value: "on_open", label: "每次打开都提醒" },
  { value: "never", label: "永远不提醒" },
];

/**
 * 提醒时间的出厂默认值。
 *
 * ⚠️ **只是默认值**：用户可以挑任意时:分（用户 2026-09-23 明确要求，
 *    ⛔ 别做成"几个固定档位"），改完立即生效、不用重启软件。
 */
export const DEFAULT_REMINDER_TIME = "21:00";

/** 提醒策略的出厂默认值：一天提醒一次（用户 2026-09-28 亲自选的）。 */
export const DEFAULT_REMINDER_MODE: ReminderMode = "daily";

/**
 * 「点击关闭时」的两个选项。文案就是用户看到的文案。
 *
 * ⚠️ 顺序固定：`tray` 在前（它是"跟提醒走"推导出来的那一头，也是更常见的用法）。
 */
export const CLOSE_ACTION_OPTIONS: { value: CloseAction; label: string }[] = [
  { value: "tray", label: "最小化到托盘" },
  { value: "quit", label: "直接退出" },
];

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

/**
 * 「离开日记时自动锁定」的默认值：**开**。
 * 与后端 `db::DEFAULT_AUTO_LOCK_ENTRIES` 保持一致。
 *
 * ⚠️ 它同时是**读到设置之前的初值**：`EditorPane.load()` 首屏就跑，
 *    而 `getSettings()` 要等解锁之后才回得来。把"还没拿到"当成 `false`，
 *    会出现"重开软件后日记居然没锁" —— 与默认值相反，而且是**静默**的。
 */
export const DEFAULT_AUTO_LOCK_ENTRIES = true;

/**
 * 「三击左键快速解锁」的默认值：**开**（指令 15）。
 * 与后端 `db::DEFAULT_TRIPLE_CLICK_UNLOCK` 保持一致。
 *
 * ⚠️ 它同时是**读到设置之前的初值**（与 `DEFAULT_AUTO_LOCK_ENTRIES` 同理）：
 *    设置存在加密库里，得等解锁之后才读得到。
 */
export const DEFAULT_TRIPLE_CLICK_UNLOCK = true;

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
// 修改主密码
// ---------------------------------------------------------------------------

/**
 * 修改主密码的结果。
 *
 * 为什么不直接给 `AppStatus`：改密码**成功之后**还有两件收尾
 * （换提示语、同步免密钥匙文件），而它们失败时密码其实**已经换掉了**。
 * 用异常表达会把用户带向"再试一次旧密码"，而真相是旧密码已经作废；
 * 闷着不说又会让人以为一切都好了。所以收尾问题单独走 `warnings`，
 * 界面必须如实显示。
 */
export interface ChangePasswordResult {
  /** 改完之后的最新状态（提示语、剩余尝试次数都可能变了）。 */
  status: AppStatus;
  /** 收尾阶段的非致命问题。空数组 = 全部干净。 */
  warnings: string[];
}

/**
 * 修改主密码。
 *
 * 后端在已解锁的连接上执行 `PRAGMA rekey`，SQLCipher 会把整个库用新密钥
 * **重新加密一遍**：不需要自己解密再重写，表结构与数据都不变。
 *
 * 三件事必须在界面上讲清楚：
 *   1. `newHint` 是**新**提示语，传 `null` = 清除。旧提示往往是照着旧密码写的，
 *      不换掉的话，用户下一次输错密码看到的就是照着旧密码写的提示 —— 直接误导。
 *   2. **此前的备份仍需用旧密码打开**：rekey 只重新加密主库，
 *      备份目录里的历史文件一个字节都没被碰过。
 *   3. 失败会**计入锁定期**（连续 5 次锁定 10 分钟），它不是"随便试试"的入口。
 */
export const changePassword = (
  oldPin: string,
  newPin: string,
  newHint: string | null
) => invoke<ChangePasswordResult>("change_password", { oldPin, newPin, newHint });

// ---------------------------------------------------------------------------
// 免密打开
// ---------------------------------------------------------------------------

/**
 * 用免密钥匙解锁 —— 启动时自动调用，用户看不到这一步。
 *
 * 原理：**不是给库加一把新钥匙，而是把库现有密钥复制一份明文存到库外**
 * （`data/auto_login.json`），所以整个过程不涉及 `PRAGMA rekey`，
 * 开关的成本只是写 / 删一个文件。密码**没有被取消**，它仍然有效。
 *
 * ⚠️ 失败意味着钥匙文件已不可用（改过密码而同步失败 / 文件被改坏），
 *    后端会把那个文件**删掉**，界面应回退到密码解锁并说明原因 ——
 *    否则下次启动还会再失败一次。用户原来的密码始终有效。
 *
 * 与 `enableAutoLogin` 的区别：这条**不需要密码**（钥匙就是凭证），
 * 所以它在未解锁状态下也调得动。
 */
export const unlockWithAutoKey = () =>
  invoke<AppStatus>("unlock_with_auto_key");

/**
 * 开启免密打开。**必须给密码**。
 *
 * 为什么开启也要密码：否则任何人趁你屏幕还解锁着点两下，
 * 就能把它变成永久免密入口。失败计入锁定期（连续 5 次锁定 10 分钟）。
 *
 * ⚠️ 界面必须如实写出代价，不许粉饰：
 *    钥匙明文躺在磁盘上，开启后机密性只挡"误开"和通用工具直读；
 *    `data/` 整体被拷走 = 库能被直接打开。
 */
export const enableAutoLogin = (pin: string) =>
  invoke<AppStatus>("enable_auto_login", { pin });

/**
 * 关闭免密打开。**同样要求密码**。
 *
 * 理由不是防人，是**帮用户确认"我还记得密码"** ——
 * 否则关掉之后下次启动就进不去了，而他刚做的事看起来只是"关个开关"。
 *
 * ⚠️ 关掉**不等于钥匙作废**：删文件只是让程序不再读它，磁盘上可能仍有残留。
 *    要真正作废，必须**更换主密码**（那会用新密钥把整库重新加密）。
 */
export const disableAutoLogin = (pin: string) =>
  invoke<AppStatus>("disable_auto_login", { pin });

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

/**
 * 统计（统计面板与顶栏那行小字共用）。
 *
 * `today` 在这里补上，调用方不用管。为什么由前端提供"今天"：
 * 只有前端知道用户的**本地日期**（`todayKey()`）；后端只有 UTC，
 * 东八区凌晨 0~8 点会被算成前一天 —— 那正是日记应用最不能错的地方。
 * 它只影响"本周 / 本月"两项。
 */
export const getStats = () => invoke<Stats>("stats", { today: todayKey() });

/**
 * 「回顾」那一屏的数据（P2-23）。
 *
 * ⚠️ **与 `getStats()` 分开**，而且**只在用户点开「旧影」时才算** —— 这条要跑
 *    三遍全表扫描（最长的一篇 / 照片最多的一篇 / 连续心情），开机白算不值当。
 *    所以 ⛔ 别把它塞进 `loadAux()`。
 *
 * `today` 同样在这里补上；后端只用它做格式校验（"往年今天"由前端判定）。
 */
export const getRecap = () => invoke<Recap>("recap", { today: todayKey() });


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
// 筛选（P2-7）
// ---------------------------------------------------------------------------

/**
 * 筛选条件的形状。
 *
 * ⚠️ **空＝不限**：不传 `tags` 是"不按标签筛"，不是"筛没有标签的"。
 *    `tags` 与 `moods` 各自内部是**并集**，两组之间是**交集**。
 */
export interface FilterQuery {
  /** 标签 id（**不是名字** —— 名字能改，id 不会）。 */
  tags?: number[];
  /** 1~5。 */
  moods?: number[];
  /** `YYYY-MM-DD`，**含两端**。只给一个也能用（＝从某天起 / 到某天止）。 */
  from?: string | null;
  to?: string | null;
  /** 默认 `true`＝最近优先；`false`＝最早优先。只影响 `DESC` / `ASC`。 */
  recentFirst?: boolean;
  /** 默认 200（后端会夹进 1~500）。 */
  limit?: number;
}

/**
 * 按标签 / 心情 / 时间捞日记（**纯读**）。
 *
 * ⚠️ 与 `searchEntries` 是两件事，别混：
 *    搜索吃的是**一个查询词**、走全文索引；这里吃的是**条件**、走普通查询。
 * ⚠️ 锁定过的日记**照常返回**、摘要也照常给 —— 与搜索一致
 *    （"锁定"一直是只读的意思，不是隐藏）。
 */
export const filterEntries = (q: FilterQuery = {}) =>
  invoke<FilterResult>("filter_entries", {
    tags: q.tags ?? [],
    moods: q.moods ?? [],
    from: q.from ?? null,
    to: q.to ?? null,
    recentFirst: q.recentFirst ?? true,
    limit: q.limit ?? null,
  });

// ---------------------------------------------------------------------------
// 标签
// ---------------------------------------------------------------------------

/**
 * 标签名的长度上限（**字符数**，不是字节数）。与后端 `db::TAG_MAX_CHARS` 一致。
 *
 * 前端拿它做 `maxlength` 只是省得用户白打一遍；真正管用的是后端那道校验 ——
 * 这里改成 50 也不会让超长标签落库。
 */
export const TAG_MAX_CHARS = 20;

/** 输入提示里最多显示几条候选。纯界面参数，后端不认识它。 */
export const TAG_SUGGEST_LIMIT = 8;

/**
 * 所有标签 + 每个标签的日记篇数（只数"写过"的）。
 *
 * 排序由**后端**定死（按名字、忽略大小写）。前端不要再排一次 ——
 * 两处各排一次，迟早出现"下拉提示里的顺序和侧栏不一样"。
 */
export const listTags = () => invoke<TagStat[]>("list_tags");

/**
 * 某天日记上的标签名（按名字排序）。那天没有日记 → 空数组。
 *
 * 与 `openEntry` 分开取，不塞进 `Entry`：
 * `Entry` 会在每次保存（1 秒防抖一次）时返回，往里加标签就意味着
 * 每次自动保存都多查一次标签表 —— 为了一个不常变的东西付高频代价。
 */
export const tagsOfEntry = (date: string) =>
  invoke<string[]>("tags_of_entry", { date });

/**
 * 整组覆盖某天日记的标签。返回**实际存下来的**标签名。
 *
 * 语义是"传什么就是什么"，不是增量：
 *   加一个 → 传 `[...旧, 新]`；撤一个 → 传 `旧.filter(x => x !== 要撤的)`。
 * 所以两次调用之间**不要**并发（后端按整组算差集，并发会彼此覆盖）。
 *
 * ⚠️ 日记必须**已经有正文**，否则后端返回 `validation` 错误（"先写点内容"）。
 *    原因是标签挂在 `entry_id` 上，而 entry 行是保存正文时产生的 ——
 *    空日记的 id 是 0。界面上要先把标签区置灰；调用前若正文还没落库，
 *    要**先 await saveEntry**（本项目的编辑器就是这么做：flush 之后再调）。
 *
 * ⚠️ 返回值以后端的为准去刷界面：清洗规则（去空白 / 限长 / 忽略大小写去重）
 *    住在后端，前端自己算的那份必然与它差一点，那就成了两套真相。
 */
export const setEntryTags = (date: string, tags: string[]) =>
  invoke<string[]>("set_entry_tags", { date, tags });

/**
 * 标签改名。新名字已被**别的**标签占用时返回 `validation` 错误，**不合并**。
 *
 * 为什么不自动合并：改名与合并不是一回事，合并要动两批日记的全部关联行。
 * 真要合并应当明说 —— 所以这里宁可报错，也不悄悄把两个标签并成一个。
 *
 * 返回清洗后的最终名字：后端会 trim、会检查长度，界面拿它回显。
 */
export const renameTag = (id: number, newName: string) =>
  invoke<string>("rename_tag", { id, newName });

/**
 * 让一个标签"退休"（界面上的「删除」）。
 *
 * ⚠️ 它**既不删标签行、也不碰日记内容**：只把 `tag.retired` 置 1 ——
 *    于是这个标签从"可选列表"里消失，而**已经贴过它的日记照旧显示它**。
 *    这才是用户要的：我以后不想再用它了，但别改我的历史。
 *    再敲一次同名标签会自动把它复活。
 *
 * 返回"有几篇日记挂着它"，界面拿它说一句实话：
 * "已移除「旅行」——另有 2 篇日记仍保留这个标签"。
 * 不说的话，用户看到"删除"两个字，第一反应就是"我的日记呢"。
 *
 * 标签不存在 / 已经退休时都不报错（幂等），界面上连点两下不该出错。
 */
export const retireTag = (id: number) => invoke<number>("retire_tag", { id });

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

/**
 * 把一份备份说清楚 —— **纯只读**，不会创建、移动、删除任何文件。
 *
 * 恢复前的确认弹窗靠它填内容（时间 / 大小 / 篇数 / 能不能用当前密码打开）。
 *
 * ⚠️ **未解锁时也能调**：换电脑那个场景里界面还停在「创建密码」，
 *    那时没有任何密码可输 —— 后端会返回 `key_available: false`，
 *    而非报错。
 */
export const inspectBackup = (dbPath: string) =>
  invoke<BackupInfo>("inspect_backup", { dbPath });

/**
 * 用一份备份**替换**当前整个库。
 *
 * ⚠️ 全应用唯一会覆盖整库的操作。调用前必须做到两件事：
 *    ① 用户明确确认过（见 `RestoreDialog`）；
 *    ② **先 `flushNow()`** 把编辑器里没保存的正文落库 ——
 *       否则连"后悔药"里都没有最后那几秒写的东西。
 *
 * 返回**恢复后**的状态，前端直接拿它覆盖，不用再查一次。
 * 若那份备份不是当前密码加密的，返回的 `unlocked` 会是 `false`（回解锁页）。
 */
export const restoreBackup = (dbPath: string) =>
  invoke<AppStatus>("restore_backup", { dbPath });

/**
 * 把整个 `backups/` 目录复制到别的盘（含 `pre-restore/`）。
 *
 * 补的是"备份和日记在同一块硬盘上"这个缺口：那块盘坏了，备份陪葬。
 * ⚠️ **绝不覆盖**目标里已有的文件（重名加 ` (1)` 后缀），也**绝不删源**。
 * 目标目录不能落在数据目录内部 —— 后端会拒绝并说明原因。
 */
export const copyBackupsTo = (destDir: string) =>
  invoke<CopyBackupsResult>("copy_backups_to", { destDir });

export const integrityCheck = () => invoke<IntegrityReport>("integrity_check");

export const rebuildIndexes = () => invoke<number>("rebuild_indexes");

// ---------------------------------------------------------------------------
// Markdown 导出（防止被这个软件锁死）
// ---------------------------------------------------------------------------

/**
 * 把整个库导出成 Markdown 文件树。
 *
 * 产物：`<destDir>/index.md` + `<destDir>/YYYY/MM/YYYY-MM-DD.md`。
 * 单篇内容是 YAML front-matter（date/title/mood/tags/word_count）+ **正文原文**，
 * 正文一字不改（不经过 Markdown 渲染再转回来，否则软换行与缩进会被吃掉）。
 *
 * ⚠️ **不覆盖已有文件**：重名会在扩展名前加后缀，`renamed` 是加后缀的次数。
 *    所以对同一个目录重复导出会产生 `xxx (1).md` 这样的副本，而不是更新原文件。
 *    想拿到干净的一份，先清空目标目录或换一个空目录。
 *
 * @param destDir 目标目录，可以不存在（会自动创建）。界面用
 *   `AppStatus.export_default_dir` 预填。
 */
export const exportMarkdown = (destDir: string) =>
  invoke<ExportResult>("export_markdown", { destDir });

/** 导出格式（【P2-8】）：Markdown 还是网页。两个都产出文件，只是给谁读不同。 */
export type ExportFormat = "md" | "html";

/**
 * 导出格式在设置页里的选项。
 *
 * ⚠️ 它是**界面偏好**，住 `localStorage`（与"折叠日历栏"同一类）——
 *    ⛔ 不进加密库的 `app_settings`：那样要动后端四处（db / commands / lib.rs / api），
 *    而它既不是日记内容、也不需要加密。
 */
export const EXPORT_FORMAT_OPTIONS: { value: ExportFormat; label: string }[] = [
  { value: "md", label: "Markdown（.md）" },
  { value: "html", label: "网页（.html）" },
];

/**
 * 把整个库导出成**网页**文件树（【P2-8】）。
 *
 * 产物：`<destDir>/index.html` + `<destDir>/YYYY/MM/YYYY-MM-DD.html`。
 * 每个 `.html` 都能**脱离本软件、断网双击打开**（样式内嵌、零外部依赖）。
 *
 * ⚠️ 与 `exportMarkdown` 是同一件事的两种格式，**产物形状、不覆盖规则、
 *    返回结构完全一致** —— 区别只有"给谁读"：Markdown 给编辑器，网页给浏览器。
 *
 * ⚠️ 导出的目录页是**倒序**（最近的在上），与 `index.md` 的升序刻意不同。
 * ⚠️ 图片附件**不导出**（那是明文副本），只在头部写一句"另有 N 张图片"。
 *
 * @param destDir 目标目录，可以不存在（会自动创建）。界面用
 *   `AppStatus.export_default_dir` 预填。
 */
export const exportHtml = (destDir: string) =>
  invoke<ExportResult>("export_html", { destDir });

/**
 * 导出**单篇**日记为 Markdown 文本（不落盘）。给"复制为 Markdown"用。
 *
 * 与 `exportMarkdown` 共用同一套渲染，所以复制出来的和落盘导出的一定一致。
 * 那天没有记录时后端返回 `validation` 错误。
 */
export const exportEntryMarkdown = (date: string) =>
  invoke<string>("export_entry_markdown", { date });

/**
 * 在系统文件管理器里打开一个目录（导出完成后让用户点一下看到产物）。
 *
 * 只接受**已存在的目录**：非目录后端返回 `validation` 错误。
 */
export const revealDir = (path: string) => invoke<void>("reveal_dir", { path });

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

/**
 * 设置「离开日记时自动锁定」（指令 14）。
 *
 * 参数就是布尔值，没有非法值可挡 —— 校验/兜底全在后端数据层。
 *
 * ⚠️ 关掉它**不等于**解锁已经锁上的日记：它只影响"以后要不要自动锁"。
 *    已经锁上的那篇仍要点 🔒 才能编辑（否则就成了"改个设置
 *    把所有保护一次性抹掉"）。
 * ⚠️ 写入失败时界面必须回滚成原值（见 SettingsPanel 的开关处理）。
 */
export const setAutoLockEntries = (on: boolean) =>
  invoke<void>("set_auto_lock_entries", { on });

/**
 * 设置「三击左键快速解锁」（指令 15）。
 *
 * 参数就是布尔值，没有非法值可挡 —— 校验/兜底全在后端数据层。
 *
 * ⚠️ 关掉它**只是关掉这个手势**：手动 🔒 / 🔓 按钮照旧好用，
 *    也不会解锁任何已经锁上的日记。
 * ⚠️ 写入失败时界面必须回滚成原值（见 SettingsPanel 的开关处理）。
 */
export const setTripleClickUnlock = (on: boolean) =>
  invoke<void>("set_triple_click_unlock", { on });

/**
 * 读「点击关闭时」——**生效值**（【P2-21】）。
 *
 * ⚠️ 它读的是"真的点 ✕ 会发生什么"，不是"库里存了什么"：
 *    托盘在这台机器上建不起来时，后端一律返回 `"quit"`
 *    （否则用户点 ✕ ⇒ 窗口消失、托盘上又没图标 ⇒ 他再也回不来了）。
 *    所以设置页**要显示这一条的结果**，别自己从 `getSettings()` 里挑字段 ——
 *    那个字段可能显示"最小化到托盘"而实际却是直接退出。
 */
export const getCloseAction = () => invoke<CloseAction>("get_close_action");

/**
 * 写「点击关闭时」（【P2-21】）。
 *
 * ⚠️ 存的是**用户的选择**，后端不会拿"这台机器有没有托盘"去改写它 ——
 *    换个环境就有了。真正生效与否由读取路径判定（见 `getCloseAction`）。
 * ⚠️ 写入失败时界面必须回滚成原值（见 SettingsPanel 的处理）。
 */
export const setCloseAction = (action: CloseAction) =>
  invoke<void>("set_close_action", { action });

/**
 * 真的退出应用（【P2-21】）。
 *
 * ⚠️ **只能在前端落完库之后调它**：正文是 1 秒防抖保存的，
 *    早调一步就会丢掉"点 ✕ 前最后打的那几个字"。
 *    正常路径是：后端发 `app-quit-requested` → 前端 `flushNow()` → 这条。
 */
export const quitApp = () => invoke<void>("quit_app");

// ---------------------------------------------------------------------------
// 写作提醒与开机自启（【P2-13】）
// ---------------------------------------------------------------------------

/**
 * 打开 / 关掉写作提醒。
 *
 * ⚠️ 它**只管存开关**：判断"到点没有 / 今天写过没有"、挂横幅，
 *    全在 `App.vue`（只有前端知道本地日期，后端只有 UTC）。
 * ⚠️ 打开/关掉提醒会**改变「点击关闭时」的显示值**（没设过时跟提醒走），
 *    所以改完要**重新 `getSettings()`**，否则设置页还显示旧值。
 */
export const setReminderEnabled = (on: boolean) =>
  invoke<void>("set_reminder_enabled", { on });

/**
 * 写提醒时间。**返回洗净后的值**（`"9:5"` ⇒ `"09:05"`）。
 *
 * ⚠️ 前端要拿返回值**回填那个输入框** —— 这是"用户输了个怪东西"唯一的
 *    可见反馈：它**不报错**（任何输入都能得出一个合法结果），只会被修正。
 */
export const setReminderTime = (time: string) =>
  invoke<string>("set_reminder_time", { time });

/** 写提醒的重复策略。参数是联合类型 ⇒ 非法值在类型层就进不来。 */
export const setReminderMode = (mode: ReminderMode) =>
  invoke<void>("set_reminder_mode", { mode });

/**
 * 记下"今天已经响过提醒了"。
 *
 * ⚠️ **只能在真的提醒过之后调**：它是 `daily` 档"一天一次"那个承诺的凭据，
 *    提前写下去会让当天**再也不响**（比多响一次糟得多）。
 * ⚠️ 日期由前端给（只有前端知道本地日期）。
 */
export const setReminderLastFired = (date: string) =>
  invoke<void>("set_reminder_last_fired", { date });

/**
 * 把主窗口叫到前台 ＋ 闪任务栏。**提醒真的响了那一刻**调它。
 *
 * ⚠️ 它不返回错误、也不该失败：窗口找不到就算了 ——
 *    横幅已经挂在界面上了，用户照样看得见。
 * ⚠️ 放在 Rust 侧是因为"抢前台"常被 Windows 拦掉，那时要退成闪任务栏，
 *    而闪任务栏只有 Rust 侧做得到。
 */
export const presentReminder = () => invoke<void>("present_reminder");

/**
 * 打开 / 关掉「开机自启」。
 *
 * ⚠️ 后端**先写注册表、再写库**；注册表那一步失败会**把错误报上来** ——
 *    这是用户亲手点的开关，"点了没反应"是最不能接受的，界面上必须提示。
 */
export const setAutoStart = (on: boolean) => invoke<void>("set_auto_start", { on });

/**
 * 把注册表里的自启路径校正成**当前这个 exe**（幂等，已经对了就不动）。
 *
 * ⚠️ 调用时机：**每次解锁之后**（`loadSettings()` 之后）。
 *    软件换了位置（换目录 / 重新发布到别处）之后，注册表里那条命令
 *    还指着旧路径 ⇒ 症状是"自启明明开着，开机却什么都没发生"，
 *    而这条线索**极难自查**（注册表不是用户会去看的地方）。
 * ⚠️ 后端只在"用户确实开着自启"时才动注册表 —— 从别处的 exe 启动一次
 *    不会把他的自启悄悄改到那个路径上。
 */
export const syncAutoStart = () => invoke<void>("sync_auto_start");

/**
 * 每日字数目标的默认值：`0` ＝ **不用这个功能**（【P2-12】）。
 *
 * ⚠️ 默认必须是"不用"：这是个纯鼓励性的数字，用户没要求时屏幕上
 *    不该出现任何"你还差多少字"的东西（与提醒"默认关"同一方向）。
 * ⚠️ 初值就用它 —— 设置要等解锁才读得回来，那段时间里
 *    编辑器底部**不该先闪一下目标再消失**。
 */
export const DEFAULT_DAILY_WORD_GOAL = 0;

/** 前端能填的最大值，与后端 `db::MAX_DAILY_WORD_GOAL` 一致。 */
export const MAX_DAILY_WORD_GOAL = 100000;

/**
 * 写「每日字数目标」（【P2-12】）。**返回后端洗净后的值**。
 *
 * ⚠️ 参数是**字符串**（输入框里那个原文）：用户会清空它 ⇒ 必须能把
 *    "留空"这个状态传下去（留空 ＝ `0` ＝ 不用）。
 * ⚠️ 必须拿返回值**回填输入框**：这一项不报错，只会被修正
 *    （`-5` ⇒ `0`、`999999` ⇒ `100000`），不回填的话用户看到的
 *    和真正存下去的就**不是同一个数**。
 */
export const setDailyWordGoal = (goal: string) =>
  invoke<number>("set_daily_word_goal", { goal });

// ---------------------------------------------------------------------------
// 图片附件（P1 #10）
// ---------------------------------------------------------------------------

/** 一条附件记录（只有元信息，没有字节）。与 Rust 的 `db::Attachment` 一一对应。 */
export interface Attachment {
  id: number;
  /** 原文件名。只用于显示（正文里的 alt 文本），落盘名字是 sha256。 */
  file_name: string;
  /** 相对数据目录的路径，形如 `attachments/<sha256>.<ext>`。 */
  stored_rel: string;
  /** 绝对路径，由 `stored_rel` 推导（不入库）。 */
  abs_path: string;
  mime: string;
  byte_size: number;
  sha256: string;
  created_at: string;
}

/** 「清理图片缓存」的结果。 */
export interface PruneReport {
  files_removed: number;
  rows_removed: number;
  bytes_freed: number;
}

/** 单张图片上限（字节）。与后端 `db::MAX_ATTACHMENT_BYTES` 保持一致。 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * 允许的图片扩展名。**前端这一道只是提前拦一下**（省得白传 20 MB 出去），
 * 真正的判据在后端：扩展名 + MIME + 文件头魔数，三样都要对上。
 */
export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"];

/** 文件名要走 IPC 请求头，而头里只能放 ASCII —— 所以先 base64，后端再解回来。 */
function toBase64Ascii(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * 存一张图片。
 *
 * ⚠️ 这条**故意不像别的封装那样传对象**：图片字节走 Tauri 的 IPC **原始通道**
 *    —— args 直接传 `Uint8Array`，Tauri 就把整个 body 当作
 *    `application/octet-stream` 发过来；其余三个参数走请求头。
 *    要是把 `Uint8Array` 夹在对象里，Tauri 会先 `Array.from()` 成"两千万个
 *    数字的数组"，20 MB 的图立刻变得不可用（见 commands.rs 里同名的说明）。
 *
 * 前端拿不到用户选中文件的**绝对路径**（WebView 不给），所以只能把字节传过去。
 * 这也正好：后端要的本来就是"字节"，路径反而没有意义。
 */
export async function saveAttachment(
  date: string,
  file: File
): Promise<Attachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return invoke<Attachment>("save_attachment", bytes, {
    headers: {
      "x-diary-date": date,
      "x-diary-mime": file.type || "",
      "x-diary-name": toBase64Ascii(file.name),
    },
  });
}

/** 某一天的全部附件（不含字节）。 */
export const listAttachments = (date: string) =>
  invoke<Attachment[]>("list_attachments", { date });

/**
 * 读一张图片的字节，返回可以直接 `URL.createObjectURL` 的 Blob。
 *
 * 后端回的是原始字节（`tauri::ipc::Response` → 前端拿到 `ArrayBuffer`），
 * 全程不走 base64、也不进 JSON。`mime` 由调用方带上（从 `listAttachments`
 * 的结果里来）—— 这条命令只回字节，因为响应体只能装一样东西。
 */
export async function readAttachmentBlob(
  id: number,
  mime: string
): Promise<Blob> {
  const buf = await invoke<ArrayBuffer>("read_attachment", { id });
  return new Blob([buf], { type: mime || "application/octet-stream" });
}

/** 删一张图片（删记录，并在没有别的记录引用同一份文件时把文件也删掉）。 */
export const deleteAttachment = (id: number) =>
  invoke<void>("delete_attachment", { id });

/** 清理图片缓存：清掉孤儿文件与失效记录。 */
export const pruneOrphanAttachments = () =>
  invoke<PruneReport>("prune_orphan_attachments");
