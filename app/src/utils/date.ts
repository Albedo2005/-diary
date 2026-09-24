/**
 * 日期工具。
 *
 * 全部基于**本地日期**，不用 UTC。原因：用户说的"今天"是他所在时区的今天。
 * 如果按 UTC 算，东八区用户在 08:00 之前写日记会被归到前一天 ——
 * 对日记应用来说这是严重错误。
 */

/** 格式化为 'YYYY-MM-DD'（本地时区）。 */
export function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 今天的日期键。 */
export const todayKey = () => toDateKey(new Date());

/** 格式化为 'YYYY-MM'（本地时区）。 */
export function toMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** 从 'YYYY-MM' 解析出该月第一天。 */
export function monthStart(month: string): Date {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1);
}

/** 月份加减。 */
export function shiftMonth(month: string, delta: number): string {
  const d = monthStart(month);
  d.setMonth(d.getMonth() + delta);
  return toMonthKey(d);
}

/**
 * 'YYYY-MM-DD' 加减天数（本地时区）。热力图逐日铺那 371 个格子用它。
 *
 * ⚠️ 结果必须由 `toDateKey()` 拼装，**不要**自己写模板字符串 ——
 *    本地时区取年月日与补零只有一处实现（就是这个文件顶部那两个函数）。
 *    走 `new Date(y, m - 1, d + delta)` 而不是 `setDate()` 也一样安全：
 *    构造时多出来的天数会由 `Date` 自动进位跨月跨年。
 */
export function shiftDate(key: string, delta: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return toDateKey(new Date(y, m - 1, d + delta));
}

/**
 * 从「写过的日期列表」里挑出与 `key` **同年同月同日**的那些，按年份**降序**（最近的排最前）。
 *
 * 使用者有两处，用的是**同一句判定**：
 *   - 「那年今日」取**第一条**（＝最近的一年）；
 *   - 【P2-23】回顾页的"往年今天"在此之上**逐年全列**。
 * ⚠️ 正因为它有两个使用者，才必须住在这个文件里 —— 别把它写成某个组件内部的私有循环。
 *
 * ⚠️ **判定只在"后端返回的真实日期列表"上做，绝不自己拼日期年。**
 *    手写 `new Date(y - 1, m - 1, d)` 撞上 2/29 会造出一个**并不存在**的日期
 *    （2024-02-29 减一年得到 2023-02-29，而 2023 年根本没有这天），
 *    拼出来的串在列表里根本找不到，于是"闰日那天的往年今天"会静默失灵。
 *    列表里出现的每个日期都是真实存在的，"周年"因此天然安全。
 *
 * @param dates 写过的日期（'YYYY-MM-DD'，顺序无所谓；调用方传的是"全部写过的日子"）
 * @param key   参照的那一天（'YYYY-MM-DD'）
 */
export function sameDayInPastYears(dates: string[], key: string): string[] {
  // key.slice(4) = '-MM-DD'，正好带着前导连字符，可以直接当后缀比对。
  const suffix = key.slice(4);
  // 默认字符串排序＝年月日逐位比较；等宽格式下就等于时间升序，反过来即年份从近到远。
  return dates
    .filter((d) => d.endsWith(suffix) && d < key)
    .sort()
    .reverse();
}

/** 该月的天数。 */
export function daysInMonth(month: string): number {
  const d = monthStart(month);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/** 该月第一天是星期几（0 = 周日）。用于日历排版留空格。 */
export function firstWeekday(month: string): number {
  return monthStart(month).getDay();
}

/**
 * 生成该月的日期网格，前导空格用 null 填充。
 *
 * 日历用"周一到周日"排列：中国用户的习惯，周日排在最后。
 */
export function monthGrid(month: string): (string | null)[] {
  const total = daysInMonth(month);
  const jsWeekday = firstWeekday(month); // 0=周日
  // 转成"周一为 0"的偏移
  const offset = (jsWeekday + 6) % 7;
  const cells: (string | null)[] = Array(offset).fill(null);
  for (let i = 1; i <= total; i++) {
    cells.push(`${month}-${String(i).padStart(2, "0")}`);
  }
  return cells;
}

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 'YYYY-MM-DD' -> Date（本地时区；只取年月日，不碰时分秒）。 */
function fromDateKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** 'YYYY-MM-DD' -> '9月11日 周五' */
export function humanDate(key: string): string {
  const d = fromDateKey(key);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`;
}

/**
 * 'YYYY-MM-DD' -> '2026年9月11日 周五'
 *
 * 和 `humanDate` 只差一个**年份**。统计面板一律用这个：
 * 那里画的是**跨年的区间**（"从 … 到 …"、连续天数数到哪一天），
 * 不带年份在跨年之后会读成"从 12月30日 到 1月2日"这种看着在倒着走的数字。
 * 编辑区 / 搜索结果上下文明确（就摆在当天那篇日记里），继续用短的那个。
 */
export function humanDateFull(key: string): string {
  const d = fromDateKey(key);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${
    WEEK[d.getDay()]
  }`;
}

/** 'YYYY-MM' -> '2026年9月' */
export function humanMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${y}年${m}月`;
}

/** Unix 秒 -> 本地可读时间 */
export function humanTime(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/** 字节数 -> 可读体积 */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
