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
  /**
   * 是否开启了免密打开（`data/auto_login.json` 是否存在）。
   *
   * ⚠️ 这个字段读的是**库外文件**，所以未解锁时也是准的 ——
   *    启动流程正是靠它决定"走不走免密"。它不是加密库里的设置项。
   */
  auto_login: boolean;
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
 * 删标签。**只删标签与关联行，日记内容一个字都不动**（外键方向保证了这点）。
 *
 * 返回受影响的关联数（≈ 多少篇日记用过它），用来给用户一句实话：
 * "已删除「旅行」，3 篇日记的标签被移除 —— 日记内容未受影响"。
 * 不这么说，用户会以为自己刚把三篇日记删了。
 *
 * 删不存在的标签不报错（幂等），界面上连点两下不该出错。
 */
export const deleteTag = (id: number) => invoke<number>("delete_tag", { id });

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
