<script setup lang="ts">
/**
 * 日记编辑器。
 *
 * 形态：**Markdown 源码 + 语法高亮**（形态 A），配一个一键**锁定**。
 * 为什么不做所见即所得：那是 V1 的目标（见 docs/backlog.md），
 * 复杂度是现在的 5~8 倍。而写日记最需要的是"打开就能写"，排版好看是**回看**时的需求。
 *
 * ⚠️ 右上角按钮的历史：它原来是"阅读"，把正文当 Markdown 渲染成 HTML。
 *    那个视图**会吃掉用户手动排的版** —— Markdown 的规矩是单个换行等于空格、
 *    行首空格被吞掉。用户自己排的版很好看，一进"阅读"就全塌了。
 *    所以改成了"锁定"：**正文一字不改地原样显示**，只是不可编辑。
 *    结论：Markdown 渲染对"手工排版"是破坏性的，这也是将来上所见即所得（V1）
 *    而不是继续加渲染开关的理由。
 *
 * ⚠️ 铁律：正文永远以 **Markdown 原文**落库。
 *    将来升级到所见即所得时，富文本只在内存里存在，存库前仍转回 Markdown。
 *    一旦改成 HTML/富文本 JSON，导出、搜索、备份全要重写，升级也不再平滑。
 *
 * 自动保存策略：输入停止 1 秒后落库。
 * 中文输入法组字期间**暂停保存** —— 否则会把打到一半的拼音存进数据库。
 */
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import {
  deleteEntry,
  deleteTag,
  listTags,
  lockAllEntries,
  MOODS,
  openEntry,
  saveEntry,
  setEntryLocked,
  setEntryTags,
  TAG_MAX_CHARS,
  tagsOfEntry,
  toAppError,
  type Entry,
  type TagStat,
} from "../api";
import { humanDate } from "../utils/date";

const props = defineProps<{
  date: string;
  /** 保存成功后通知父组件（用于刷新日历标记） */
  onSaved?: () => void;
  /**
   * 标签变更信号。侧栏删掉 / 改名了某个标签时由父组件递增，
   * 用来让这里的 chip 行与面板候选跟着刷新。
   */
  tagToken?: number;
}>();

const emit = defineEmits<{
  (e: "saved"): void;
  /** 本组件的标签改动也要让侧栏的标签列表知道（篇数变了）。 */
  (e: "tags-changed"): void;
  /** 给用户的一句话反馈（由 App.vue 弹 toast）—— 与侧栏走同一条通道。 */
  (e: "notice", message: string): void;
}>();

/**
 * 常用标签（预设名单）—— **前端常量，一行都不要写进库**。
 *
 * 只有用户**真正选中**的标签才进 `tag` 表。若启动时把预设 seed 进库，
 * 侧栏那份标签列表立刻会冒出十几个"0 篇"的标签，把用户自己写过的挤没。
 * 附带好处：以后想改预设名单，改这一行即可，不需要数据迁移。
 *
 * 取词按**维度**分布（兜底 / 事务 / 输入 / 精神 / 关系 / 身体 / 出行 / 生活），
 * **刻意不含情绪类** —— 心情标记（MOODS）已经承担了"今天整体怎么样"，
 * 标签负责的是"这篇写了什么主题"，两套体系不重叠。
 * 详细理由见《Diary-P1功能设计规格.md》功能 1 →「增强」。
 */
const PRESET_TAGS = [
  "日常",
  "工作",
  "学习",
  "计划",
  "读书",
  "灵感",
  "反思",
  "家人",
  "朋友",
  "运动",
  "旅行",
  "假期",
  "美食",
  "健康",
];

const loading = ref(false);
const errorText = ref("");
const title = ref("");
const content = ref("");
/** '' | 'pending' | 'saving' | 'saved' | 'error' */
const saveState = ref<"" | "pending" | "saving" | "saved" | "error">("");
/** 锁定：正文只读。注意锁的是**能否修改**，不是显示方式。 */
const locked = ref(false);
const entry = ref<Entry | null>(null);

/**
 * 当前这篇的心情。null = 未标记。
 *
 * 档位表（数值 ↔ emoji）在 `api/index.ts` 的 `MOODS` —— 与日历共用同一份，
 * 避免“编辑器标的是开心、日历显示受伤”这类漂移。
 */
const mood = ref<number | null>(null);

/**
 * 这一篇当前**应当**有的标签（界面渲染 + 提交依据）。
 *
 * 每次交互先本地更新它（即时反馈），随后串行提交给后端；
 * 提交返回后**用后端返回的那份覆盖回来** —— 清洗规则（去空白 / 限长 /
 * 忽略大小写去重）住在后端，本地那份必然差一点，界面的最终状态
 * 必须以库里为准，不能停在"前端自己那条推理链"上。
 */
const tags = ref<string[]>([]);

/** 标签输入框里的内容（还没提交）。 */
const tagInput = ref("");
/** 全库的标签（含篇数）。「其他」组的候选来自它。 */
const allTags = ref<TagStat[]>([]);
/** 标签面板是否展开。 */
const panelOpen = ref(false);
const tagError = ref("");

/**
 * 待确认删除的标签（null = 没有）。
 *
 * 「其他」组 chip 上那个 × **不直接删** —— 先把目标放这儿，面板底部弹出
 * 一条确认。理由见 confirmDelete()。
 */
const pendingDelete = ref<TagStat | null>(null);

/** 面板容器 / ＋ 触发按钮，用于判断"点面板外关闭"。 */
const panelRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLElement | null>(null);

/**
 * 标签区是否可编辑。
 *
 * 两道闸，与心情条同款：
 *   1. **正文为空时不能打标签**。标签挂在 entry_id 上，而 entry 行是保存
 *      正文时产生的 —— 空日记的 id 是 0，此时打标签要么插一条空行
 *      （直接破坏"打开 ≠ 写过"这条铁律），要么失败。后端也会拒，
 *      这里置灰只是为了不让用户白填一次。
 *   2. 锁定时不能改：锁定 = 只读，标签也是这篇日记的一部分。
 */
const canTag = computed(() => hasContent() && !locked.value);

/** 标签区的悬停提示 / 置灰时旁边那行说明。 */
const tagHint = computed(() => {
  if (locked.value) return "解锁后可改标签";
  if (!hasContent()) return "先写点内容，再贴标签";
  return "点 ＋ 选择标签";
});

/**
 * 心情条是否可点。
 *
 * 两道闸：
 *   1. **正文为空时不能标**。后端在正文为空时会丢掉心情，前端置灰是为了
 *      不让用户白点一次；更根本的是不让"有心情但没内容"的记录出现 ——
 *      那会与"打开 ≠ 写过"这条铁律冲突。
 *   2. 锁定时不能改，与锁定状态下其它编辑行为保持一致。
 */
const canMarkMood = computed(() => hasContent() && !locked.value);

/** 心情条的悬停提示，把"为什么点不动"讲清楚。 */
const moodHint = computed(() => {
  if (locked.value) return "解锁后可修改心情";
  if (!hasContent()) return "先写点内容，再标心情";
  return "今天心情如何？再点一次可取消";
});

/**
 * 「其他」组：库里真实存在的、**不在预设名单里**的标签。
 *
 * 不新增命令、不新增字段 —— `allTags`（= `listTags()`）本来就返回
 * "库里真实存在的标签"，减去预设名单，剩下的正是"用户自己写过的那些"。
 *
 * ⚠️「其他」是**分组显示**，不是合并成一个名叫"其他"的标签。
 *    标签本身各自独立（否则"旅行"和"失眠"再也分不出来，还和改名/删除打架）。
 */
const otherTags = computed(() =>
  allTags.value.filter((t) => !PRESET_TAGS.includes(t.name))
);

/**
 * 确认条上的那句话：把"会影响几篇日记"如实说清楚。
 *
 * 删除标签**碰不到正文**（外键方向是 tag → entry_tag，级联只清关联行），
 * 但用户看见"删除"两个字，第一反应就是"我的日记呢" —— 必须当场说明。
 * 篇数取自 `TagStat.entry_count`（后端按"写过"统计），前端不另算一份。
 */
const deleteHint = computed(() => {
  const t = pendingDelete.value;
  if (!t) return "";
  return t.entry_count > 0
    ? `删除标签「${t.name}」？它正被 ${t.entry_count} 篇日记使用，删除后这些日记将失去该标签（日记正文不受影响）。`
    : `删除标签「${t.name}」？目前没有日记在用它。`;
});

/**
 * 分类：某标签当前是否挂在这一篇上。面板 chip 的选中态用它。
 */
function isSelected(name: string): boolean {
  return tags.value.includes(name);
}

/** 输入法组字中。中文打字时输入法会先给出拼音候选，这段时间不能保存。 */
let composing = false;
let saveTimer: number | null = null;
/** 标记"当前内容是否已被改动但尚未保存"，避免无谓写库。 */
let dirty = false;

/**
 * 后端**最后一次确认**的标签状态。
 *
 * 用来判断"还需不需要再提交一次"（`tags` 与它不一致 = 有未落库的改动），
 * 也用来在提交失败时回滚 —— 别让界面停在一个其实没存进去的样子。
 */
let syncedTags: string[] = [];
/** 是否有一次"整组覆盖"正在飞。串行化用，见 syncTags。 */
let tagInflight = false;

/**
 * 这篇日记算不算"写过"（正文非空白）。
 *
 * ⚠️ 必须与后端 `db::HAS_CONTENT_SQL` 保持完全一致，否则会出现
 *    "编辑器认为写过、日历认为没写"这类界面自相矛盾的状态。
 *    刻意只留正文、不看标题：只打了标题没写正文不算写完一篇。
 */
function hasContent(): boolean {
  return content.value.trim().length > 0;
}

/** 数据库里是否已经存在这一行。 */
function isPersisted(): boolean {
  return entry.value !== null && entry.value.id !== 0;
}

const wordCount = computed(
  () => content.value.replace(/\s/g, "").length
);

/**
 * 切换锁定 / 解锁。
 *
 * 只调后端改一个标记位，**不提交任何正文** —— 这是"锁定不改变排版"的保证：
 * 走的接口根本不带 title/content 参数，想改也改不了。
 */
async function toggleLock() {
  const next = !locked.value;
  errorText.value = "";
  try {
    // 锁定前先把已改的内容落库，否则会丢掉"锁定前最后一次编辑"。
    if (next && dirty) await flush();
    const e = await setEntryLocked(props.date, next);
    entry.value = e;
    locked.value = e.locked;
    saveState.value = "";
  } catch (e) {
    errorText.value = toAppError(e).message;
  }
}

async function load() {
  loading.value = true;
  errorText.value = "";
  cancelPendingSave();
  try {
    // 先把所有日记锁上，再读要打开的这一篇。
    // 于是"切换日期"和"重新打开软件"都会让上一篇自动回到锁定状态。
    await lockAllEntries();
    // openEntry 是纯读取：没有内容时返回空模板（id = 0），不会写库。
    // 所以"点开日历"不会把这一天变成"写过"。
    const e = await openEntry(props.date);
    entry.value = e;
    title.value = e.title;
    content.value = e.content_md;
    locked.value = e.locked;
    mood.value = e.mood;
    // 先清空再读：读失败时宁可"看不到标签"，也不能把上一天的标签
    // 留在屏幕上冒充这一天的（那会让用户以为标签串了）。
    tags.value = [];
    syncedTags = [];
    tagInput.value = "";
    panelOpen.value = false;
    pendingDelete.value = null;
    await loadTags();
    dirty = false;
    saveState.value = "";
  } catch (e) {
    errorText.value = toAppError(e).message;
  } finally {
    loading.value = false;
  }
}

function cancelPendingSave() {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
}

/** 输入变化：标记脏数据并安排一次防抖保存。 */
function scheduleSave() {
  // 锁定时一律不保存。load() 会把内容写进 title/content，从而触发本函数 ——
  // 没有这道闸，打开一篇锁定的日记就会立刻发起一次注定被后端拒绝的保存。
  if (locked.value) return;
  // 关键：组字期间不保存，否则会存下未完成的拼音。
  if (composing) return;
  dirty = true;
  saveState.value = "pending";
  cancelPendingSave();
  saveTimer = window.setTimeout(() => {
    void flush();
  }, 1000);
}

/**
 * 把当前内容落库。
 *
 * 三条规则（都是为了"只有真的写了内容才算写过"这个语义）：
 *
 *   1. **没有正文内容时不落库**。只打了标题就离开，不应该在数据库里留下记录，
 *      更不应该让日历显示"这天写过"。
 *
 *   2. **曾经有内容、现在被删空 → 删除数据库里的行**，而不是存一条空记录。
 *      否则日历上会留下一个"写过但点进去是空的"幽灵标记。
 *
 *   3. 保存成功才通知父组件刷新日历标记。
 *      在内容为空的情况下也要通知 —— 因为可能刚刚删空了一篇，
 *      日历需要把这个标记去掉。
 */
async function flush(forDate: string = props.date) {
  if (locked.value) return; // 锁定的日记不写库
  if (!dirty) return;
  cancelPendingSave();

  // 规则 1 与 2
  if (!hasContent()) {
    if (isPersisted()) {
      saveState.value = "saving";
      try {
        await deleteEntry(forDate);
        entry.value = null;
        // 行都没了，心情自然也不存在。前端跟着清掉 ——
        // 否则界面上还留着一个高亮的表情，看着"有心情"，重开这天却是空的。
        mood.value = null;
        // 标签同理，而且是**两层**都不存在了：
        // entry 行没了 → entry_tag 的 ON DELETE CASCADE 把关联行清掉
        //（标签本身还在，可能别的日记在用）。所以这里清空的是"这一篇的标签"。
        tags.value = [];
        syncedTags = [];
        dirty = false;
        saveState.value = "";
        emit("saved");
        // 篇数少了，侧栏那份标签列表要跟着变。
        emit("tags-changed");
      } catch (e) {
        saveState.value = "error";
        errorText.value = toAppError(e).message;
      }
    } else {
      // 从来没落库过，也就没什么可保存的。
      dirty = false;
      saveState.value = "";
    }
    return;
  }

  saveState.value = "saving";
  try {
    const e = await saveEntry(forDate, title.value, content.value, mood.value);
    entry.value = e;
    dirty = false;
    saveState.value = "saved";
    emit("saved");
  } catch (e) {
    saveState.value = "error";
    errorText.value = toAppError(e).message;
  }
}

/**
 * 点选心情。
 *
 * **立即保存**，不进防抖队列：心情是个离散选择，点完就该落库。
 * 若跟着正文的 1 秒防抖走，用户点完马上切日期，这次心情会连着"未保存"
 * 一起被丢掉。
 *
 * 再点同一个档位 = 取消标记（传 null）。
 * 正文为空时直接返回 —— 按钮本来就是禁用的，这里是第二道闸。
 */
function pickMood(value: number) {
  if (!canMarkMood.value) return;
  mood.value = mood.value === value ? null : value;
  dirty = true;
  saveState.value = "pending";
  void flush();
}

/**
 * 读这一篇的标签 + 全库标签（面板「其他」组候选用）。
 *
 * 两个查询互不依赖，并发发出去。失败只记错误、不阻塞编辑 ——
 * 标签是附加信息，读不到不该让整个编辑器用不了。
 */
async function loadTags() {
  tagError.value = "";
  try {
    const [mine, all] = await Promise.all([
      tagsOfEntry(props.date),
      listTags(),
    ]);
    tags.value = mine;
    syncedTags = [...mine];
    allTags.value = all;
  } catch (e) {
    tagError.value = toAppError(e).message;
  }
}

/**
 * 把当前标签（`tags.value`）整组同步到后端。
 *
 * ⚠️ **串行 + "最后一次为准"** —— 本条最容易写错的地方。
 *
 * `set_entry_tags` 是**整组覆盖**语义：两个请求乱序到达时，后到的旧值会把
 * 新值盖掉（表现是"点了三个标签，最后只剩两个"）。所以：
 *   - 同一时刻只允许**一个**请求在飞（`tagInflight`）；
 *   - 飞行期间的每次点击都只更新 `tags.value`（累积用户意图），
 *     等当前请求回来后再用**最新**的 `tags.value` 补提交一次。
 * 这样连点多个标签最终全部落库，不会被中间态覆盖。**不要裸用 Promise.all。**
 *
 * 提交前先把正文落库：标签挂 `entry_id`，而 entry 行是 `save_entry` 的
 * upsert 产生的 —— 打了字还没到防抖就去贴标签的话，库里根本没有那一行。
 */
/** 两个标签数组是否完全一致。用来判断"还有没有改动没落库"。 */
function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

async function syncTags() {
  if (tagInflight) return;
  tagInflight = true;
  tagError.value = "";
  try {
    while (!sameTags(tags.value, syncedTags)) {
      const target = [...tags.value];
      if (dirty) await flush();
      // flush 失败（例如恰好被锁定）时别往下走：库里的行没变，
      // 提交标签只会再报一个看不懂的错。回滚到库里已知的状态。
      if (saveState.value === "error") {
        tags.value = [...syncedTags];
        break;
      }
      const saved = await setEntryTags(props.date, target);
      // 以后端返回为准：清洗规则在后端，本地那份必然差一点。
      syncedTags = [...saved];
      tags.value = [...saved];
      allTags.value = await listTags();
      // 篇数变了，侧栏那份列表也得跟着变。
      emit("tags-changed");
    }
  } catch (e) {
    tagError.value = toAppError(e).message;
    tags.value = [...syncedTags];
  } finally {
    tagInflight = false;
  }
}

/**
 * 面板 / chip 上点一下：选中 ↔ 取消，立即生效。
 *
 * 先本地更新（即时反馈），再交给 syncTags 串行提交；提交成功后会被
 * 后端的返回值覆盖回来，所以最终状态始终来自数据库。
 */
function toggleTag(name: string) {
  if (!canTag.value) return;
  tags.value = isSelected(name)
    ? tags.value.filter((t) => t !== name)
    : [...tags.value, name];
  void syncTags();
}

/**
 * 从面板输入框添加一个标签。
 *
 * 重复的直接吞掉（不报错、也不发请求）：用户常常记不清有没有加过，
 * 连点两下就弹个"已存在"很烦人。判定**忽略大小写** ——
 * 后端 `tag.name` 是 `UNIQUE COLLATE NOCASE`，`Travel` 与 `travel`
 * 本来就是同一个标签。清洗（trim / 限长 / 去重）不在这里重做一份，
 * 原样交给后端，再拿后端返回的那份刷界面。
 */
function addTag(raw: string) {
  const name = raw.trim();
  if (!name) return;
  const lower = name.toLowerCase();
  if (tags.value.some((t) => t.toLowerCase() === lower)) {
    tagInput.value = "";
    return;
  }
  tags.value = [...tags.value, name];
  tagInput.value = "";
  void syncTags();
}

/** chip × ：把标签从**这一篇**上撤掉（标签本身还留在库里）。 */
function removeTag(name: string) {
  if (!canTag.value) return;
  tags.value = tags.value.filter((t) => t !== name);
  void syncTags();
}

/**
 * 「其他」组的 × ：请求删除一个**自己写的**标签（连库一起删）。
 *
 * ⚠️ 和 removeTag 是两件事，别混：
 *    - removeTag = 只把标签从这一篇上摘掉，标签本身留在库里；
 *    - askDelete = 把标签从**整库**删掉（所有日记都不再挂它）。
 *    前者是日常编辑，后者是不可逆的管理动作，所以后者要过一道确认。
 *
 * 为什么只有这一组的 chip 有 ×：预设名单是**前端常量**、根本没进库，
 * 没有可删的东西；而"其他"里的每一个都是用户自己敲出来的 ——
 * 打错一个（"旅游" 与 "旅行" 会各占一个标签）或过阵子不想要了，
 * 应该能就地清掉，不必专门跑一趟侧栏。这正是本次增强要解的结。
 */
function askDelete(t: TagStat) {
  pendingDelete.value = t;
}

function cancelDelete() {
  pendingDelete.value = null;
}

/**
 * 确认删除：把标签从库里删掉。
 *
 * 后端 `delete_tag` 只做 `DELETE FROM tag`，挂着的关联行交给
 * `ON DELETE CASCADE`（连接已开 foreign_keys）—— **正文一行都不碰**。
 * 它返回受影响的关联行数，用来在提示里答"几篇日记失去了它"。
 *
 * 后端是幂等的（删不存在的标签不报错），连点两下不会出错。
 */
async function confirmDelete() {
  const t = pendingDelete.value;
  if (!t) return;
  try {
    const affected = await deleteTag(t.id);
    /*
      这个标签可能正挂在本篇上。库里那条 entry_tag 已随级联删掉了，
      所以本地这两份状态必须**同步摘掉** ——
      否则下一次 syncTags() 会拿着旧名单去提交，而 set_entry_tags 遇到
      库里不存在的名字会**新建**一个同名标签，等于刚删掉的又长了回来。
    */
    if (tags.value.includes(t.name)) {
      tags.value = tags.value.filter((n) => n !== t.name);
    }
    syncedTags = syncedTags.filter((n) => n !== t.name);
    pendingDelete.value = null;
    // 候选变了（被删的那个从「其他」里消失），重读全库标签。
    allTags.value = await listTags();
    // 与侧栏删除同一句话：先答"我的日记呢"，再报篇数。
    emit(
      "notice",
      affected > 0
        ? `已删除标签「${t.name}」——${affected} 篇日记的标签被移除，内容未受影响`
        : `已删除标签「${t.name}」（本来就没有日记在用它）`
    );
    // 侧栏那份标签列表要跟着变。
    emit("tags-changed");
  } catch (e) {
    tagError.value = toAppError(e).message;
    pendingDelete.value = null;
  }
}

function togglePanel() {
  if (!canTag.value) return;
  panelOpen.value = !panelOpen.value;
}

function closePanel() {
  panelOpen.value = false;
  // 关面板时顺手把悬着的删除确认撤掉：换一篇日记 / 点别处再回来，
  // 不该看到一条"上回没确认完"的问句。
  pendingDelete.value = null;
}

/**
 * 点面板外关闭。
 *
 * ⚠️ 用 `pointerdown` 而不是 `click`：`click` 会和"打开面板的那一次点击"
 *    打架（同一个事件先打开又立刻关掉）。这跟指令 9（日历快速跳转）
 *    踩过的是同一个坑，直接抄它的作业。
 */
function onDocPointerDown(ev: PointerEvent) {
  if (!panelOpen.value) return;
  const t = ev.target as Node;
  if (panelRef.value?.contains(t) || triggerRef.value?.contains(t)) return;
  closePanel();
}

/**
 * 按 Esc：**先撤删除确认，再关面板**。
 *
 * 顺序有讲究：确认条已经弹出来了，用户按 Esc 十有八九是想反悔，
 * 而不是想把整个面板收走 —— 一下关掉会让人以为"刚才那一删执行了"。
 */
function onDocKeydown(ev: KeyboardEvent) {
  if (ev.key !== "Escape") return;
  if (pendingDelete.value) {
    cancelDelete();
    return;
  }
  if (panelOpen.value) closePanel();
}

/**
 * 面板开着时才挂全局监听，关掉就摘 —— 并且**在 onUnmounted 里再摘一次**，
 * 否则反复挂载 / 卸载会累积监听器。
 */
watch(panelOpen, (open) => {
  if (open) {
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeydown);
  } else {
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onDocKeydown);
  }
});

/** 面板输入框的键盘处理：回车提交、Esc 关闭；组字期间一律不提交。 */
function onTagKeydown(ev: KeyboardEvent) {
  // ⚠️ 输入法组字期间的回车是在**选词**，不是在提交标签。
  //    不挡这一下，中文用户每打完一个词都会顺手 . 提交一次。
  if (ev.isComposing) return;
  if (ev.key === "Enter") {
    ev.preventDefault();
    addTag(tagInput.value);
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    tagInput.value = "";
    closePanel();
  }
}

/** 组字开始/结束。结束时补一次保存，把最终文本落库。 */
function onCompositionStart() {
  composing = true;
}
function onCompositionEnd() {
  composing = false;
  scheduleSave();
}

/**
 * 文本域里按下 Tab 时插入缩进而不是移动焦点。
 * 日记里写代码块或列表时很需要。
 */
function onKeydown(ev: KeyboardEvent) {
  // 只读输入框仍然会触发 keydown。不挡住的话，在锁定状态下按 Tab 会悄悄改掉
  // 内存里的 content —— 界面上看不见变化，解锁后那次编辑却会被保存进去。
  if (locked.value) return;
  if (ev.key === "Tab") {
    ev.preventDefault();
    const el = ev.target as HTMLTextAreaElement;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    content.value =
      content.value.slice(0, start) + "  " + content.value.slice(end);
    void nextTick(() => {
      el.selectionStart = el.selectionEnd = start + 2;
    });
    scheduleSave();
  }
  // Ctrl+S 手动保存（虽然自动保存已覆盖，但符合直觉）
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
    ev.preventDefault();
    void flush();
  }
}

const saveLabel = computed(() => {
  switch (saveState.value) {
    case "pending":
      return "未保存…";
    case "saving":
      return "保存中…";
    case "saved":
      return "已保存";
    case "error":
      return "保存失败";
    default:
      return "";
  }
});

watch(
  () => props.date,
  async (_next, prev) => {
    // ⚠️ 先保存，再锁定，顺序不能反。
    //
    // 两件事都容易踩错：
    //   1. load() 会 lockAllEntries()。要是先锁再存，这次保存会被刚上的锁
    //      拒绝，用户最后敲的几个字**静默消失**（界面上只闪一下"保存失败"）。
    //   2. 必须写到 prev（旧日期）。此刻 props.date 已经是新日期了，
    //      照 props.date 写会把 A 的正文覆盖到 B 那天上 —— 那比丢字更糟。
    if (dirty && prev) await flush(prev);
    await load();
  }
);
watch([title, content], scheduleSave);

/**
 * 侧栏删掉了某个标签 / 把它改了名 → 这里的 chip 行与面板候选都得刷新
 *（被删的那个可能正挂在这一篇上）。
 *
 * 自己发出的改动也会绕回来触发一次（父组件把 tagToken 递增后传回来），
 * 多查一次不算浪费：它保证界面上的最终状态**来自数据库**，
 * 而不是来自前端自己那条推理链。
 *
 * ⚠️ 只监听 tagToken，**不监听 date** —— 换日期由 load() 负责，
 *    它已经读过一次标签了，这里再读一次就是纯重复。
 */
watch(
  () => props.tagToken,
  () => void loadTags()
);

// 首屏：load() 里的 lockAllEntries() 顺带实现了
// "关掉软件再打开，所有日记都是锁的"。
void load();

// 关窗前尽力保存，减少意外丢失。
function beforeUnload(e: BeforeUnloadEvent) {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
}
window.addEventListener("beforeunload", beforeUnload);
onUnmounted(() => {
  window.removeEventListener("beforeunload", beforeUnload);
  // 面板的全局监听也要摘掉，避免反复挂载累积。
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  document.removeEventListener("keydown", onDocKeydown);
  // 组件卸载前把未落库的内容写下去。
  if (dirty) void flush();
});
</script>

<template>
  <section class="editor">
    <header class="bar">
      <div class="left">
        <span class="date">{{ humanDate(props.date) }}</span>
        <span class="meta">{{ wordCount }} 字</span>
        <span v-if="saveLabel" class="save" :class="saveState">{{
          saveLabel
        }}</span>
      </div>
      <button
        class="toggle"
        :class="{ on: locked }"
        :title="locked ? '解锁后可继续修改' : '锁定后正文只读，排版原样保留'"
        @click="toggleLock"
      >
        {{ locked ? "🔒 已锁定" : "🔓 锁定" }}
      </button>
    </header>

    <p v-if="errorText" class="error">{{ errorText }}</p>

    <div v-if="loading" class="placeholder">读取中…</div>

    <template v-else>
      <div class="title-row">
        <input
          v-model="title"
          class="title-input"
          type="text"
          placeholder="标题（可留空）"
          maxlength="200"
          :readonly="locked"
          :class="{ locked }"
        />

        <!--
          心情条：五档，当前档高亮。
          正文为空 / 锁定状态下整体置灰 —— 后端在空内容时会丢掉心情，
          置灰是为了不让用户白点，也避免产生"有心情但没内容"的记录。
        -->
        <div
          class="mood-bar"
          :class="{ disabled: !canMarkMood }"
          :title="moodHint"
        >
          <button
            v-for="m in MOODS"
            :key="m.value"
            class="mood-btn"
            :class="{ on: mood === m.value }"
            :disabled="!canMarkMood"
            @click="pickMood(m.value)"
          >
            {{ m.emoji }}
          </button>
        </div>
      </div>

      <!--
        标签区：已挂的标签是 chip（点 × 把它从**本篇**撤掉），
        末尾一个 ＋ 按钮弹出面板。
        面板分三块 —— 常用（预设名单）/ 其他（用户自己写过的，每个带一个
        × 可**从库里删除**）/ 新建输入框。

        ⚠️ 两种 × 不是一回事：chip 行那个只把标签从本篇摘掉；面板「其他」组
           那个是删整库、且删前要过一条确认。见 removeTag / askDelete 的注释。

        ⚠️ 正文为空 / 已锁定时整个区置灰，并把原因写在旁边（tagHint）——
           "为什么点不动"必须当场说清楚，否则用户只会觉得按钮坏了。
           后端也会拒（标签挂 entry_id，空日记没有 id），这里只是省得他白填。
      -->
      <div class="tag-row" :class="{ disabled: !canTag }">
        <span v-for="t in tags" :key="t" class="chip">
          <span class="chip-name">{{ t }}</span>
          <button
            class="chip-x"
            :disabled="!canTag"
            :title="canTag ? `移除标签「${t}」` : tagHint"
            @click="removeTag(t)"
          >
            ×
          </button>
        </span>

        <button
          ref="triggerRef"
          type="button"
          class="tag-plus"
          :disabled="!canTag"
          :title="canTag ? '选择或新建标签' : tagHint"
          @click="togglePanel"
        >
          ＋ 标签
        </button>

        <span v-if="!canTag" class="tag-note">{{ tagHint }}</span>

        <!--
          标签面板。绝对定位（不占版面高度），容器 .tag-row 是定位上下文。
          ⚠️ 选中态以「库里 / 本次已提交的状态」为准（isSelected 读的是 tags，
             而 tags 每次都被后端返回值覆盖），不是前端自己那条推理链。
        -->
        <div
          v-if="panelOpen && canTag"
          ref="panelRef"
          class="tag-panel"
          role="dialog"
          aria-label="标签"
        >
          <div class="panel-group">
            <div class="panel-label">常用</div>
            <div class="panel-chips">
              <button
                v-for="name in PRESET_TAGS"
                :key="name"
                type="button"
                class="panel-chip"
                :class="{ on: isSelected(name) }"
                @click="toggleTag(name)"
              >
                {{ name }}
              </button>
            </div>
          </div>

          <div class="panel-group">
            <div class="panel-label">其他</div>
            <div class="panel-chips">
              <span v-if="otherTags.length === 0" class="panel-empty">
                你写的标签会出现在这里（点 × 可删除）
              </span>
              <!--
                「其他」组用**可删除**的 chip：药丸里再切一小块当删除键。
                ⚠️ <button> 不能嵌 <button>（HTML 不允许，行为也不可预期），
                   所以外层用 <span> 承载边框与圆角，里面放两个并列的按钮。
              -->
              <span
                v-for="t in otherTags"
                :key="t.id"
                class="panel-tag"
                :class="{ on: isSelected(t.name) }"
              >
                <button
                  type="button"
                  class="panel-tag-name"
                  :title="
                    isSelected(t.name) ? '从这篇日记上撤掉' : '贴到这篇日记上'
                  "
                  @click="toggleTag(t.name)"
                >
                  {{ t.name }}
                </button>
                <button
                  type="button"
                  class="panel-tag-x"
                  :title="`删除标签「${t.name}」（只清标签，日记内容不受影响）`"
                  @click="askDelete(t)"
                >
                  ×
                </button>
              </span>
            </div>
          </div>

          <!--
            删除确认条。
            ⚠️「其他」组的 × **不直接删库** —— 那是个不可逆的管理动作，
               而它就贴在一排可点的 chip 旁边，误触的代价（几十篇日记失去标签）
               远大于多点一次的麻烦。侧栏那处不做确认，是因为它是**专门的**
               管理区、动作单一；这里混在"选择标签"的动作里，必须多一道手。
          -->
          <div v-if="pendingDelete" class="panel-confirm">
            <span class="panel-confirm-text">{{ deleteHint }}</span>
            <button
              type="button"
              class="panel-confirm-del"
              @click="confirmDelete"
            >
              删除
            </button>
            <button
              type="button"
              class="panel-confirm-cancel"
              @click="cancelDelete"
            >
              取消
            </button>
          </div>

          <div class="panel-add">
            <input
              v-model="tagInput"
              class="panel-input"
              type="text"
              placeholder="＋ 输入新标签…"
              :maxlength="TAG_MAX_CHARS"
              @keydown="onTagKeydown"
            />
            <button
              type="button"
              class="panel-add-btn"
              @click="addTag(tagInput)"
            >
              添加
            </button>
          </div>
        </div>
      </div>

      <p v-if="tagError" class="error">{{ tagError }}</p>

      <!--
        锁定与编辑共用同一个 textarea，**刻意不切换成渲染视图**。
        看得见的就是将要保存的原文：换行、空格、缩进全部原样，
        所以"锁定"不会改变排版。只读靠 readonly（不是 disabled）——
        disabled 的输入框不能选中、不能滚动，想复制一段都做不到。
      -->
      <textarea
        v-model="content"
        class="content-input"
        :class="{ locked }"
        placeholder="今天发生了什么…"
        spellcheck="false"
        :readonly="locked"
        @compositionstart="onCompositionStart"
        @compositionend="onCompositionEnd"
        @keydown="onKeydown"
      />
    </template>
  </section>
</template>

<style scoped>
.editor {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 20px 28px 24px;
}
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.left {
  display: flex;
  align-items: baseline;
  gap: 14px;
}
.date {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
}
.meta {
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.save {
  font-size: 12px;
  color: var(--text-3);
}
.save.error {
  color: var(--danger);
}
.save.saved {
  color: var(--ok);
}
.toggle {
  padding: 6px 14px;
  font-size: 13px;
  color: var(--text-2);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 7px;
  cursor: pointer;
}
.toggle:hover {
  background: var(--hover);
}
.toggle.on {
  color: #fff;
  background: var(--accent);
  border-color: var(--accent);
}
/* 标题与心情条同一行：标题吃掉剩余宽度，心情条固定宽度贴右。 */
.title-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.title-input {
  flex: 1;
  min-width: 0;
  padding: 4px 0 12px;
  font-size: 21px;
  font-weight: 600;
  color: var(--text-1);
  background: transparent;
  border: none;
  outline: none;
}
.title-input::placeholder {
  color: var(--text-3);
  font-weight: 400;
}

/* 心情条：未选中的档位淡一些，选中的高亮。 */
.mood-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.mood-btn {
  width: 28px;
  height: 28px;
  padding: 0;
  font-size: 16px;
  line-height: 1;
  opacity: 0.4;
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.mood-btn:hover:not(:disabled) {
  opacity: 1;
  background: var(--hover);
}
.mood-btn.on {
  opacity: 1;
  background: var(--accent-soft);
}
/* 不可点（正文为空 / 已锁定）：整体压暗，但仍看得见当前心情。 */
.mood-bar.disabled .mood-btn {
  opacity: 0.15;
  cursor: default;
}

/* 标签区：一行 chip + 一个 ＋ 按钮，可折行。绝对定位的面板以它为定位上下文。 */
.tag-row {
  position: relative;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 2px 0 10px;
}
/* 不可编辑（空日记 / 已锁定）：整体压暗，但仍看得见已挂的标签。
   旁边那行 tag-note 说明原因 —— 光置灰不解释，用户只会以为坏了。 */
.tag-row.disabled .chip,
.tag-row.disabled .tag-plus {
  opacity: 0.45;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 4px 2px 8px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  background: var(--accent-soft);
  border-radius: 999px;
}
.chip-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip-x {
  width: 16px;
  height: 16px;
  padding: 0;
  font-size: 13px;
  line-height: 1;
  color: var(--text-3);
  background: transparent;
  border: none;
  border-radius: 50%;
  cursor: pointer;
}
.chip-x:hover:not(:disabled) {
  color: var(--danger);
  background: var(--hover);
}
.chip-x:disabled {
  cursor: default;
}
/* ＋ 触发按钮：虚线小药丸，和 chip 视觉同一档。 */
.tag-plus {
  padding: 3px 10px;
  font-size: 12px;
  color: var(--text-3);
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: 999px;
  cursor: pointer;
}
.tag-plus:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}
.tag-plus:disabled {
  cursor: default;
}
.tag-note {
  font-size: 12px;
  color: var(--text-3);
}

/* 标签面板：绝对定位，不占版面高度（否则正文会被推下去一下）。 */
.tag-panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 30;
  width: min(430px, 82vw);
  padding: 10px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16);
}
.panel-group + .panel-group {
  margin-top: 10px;
}
.panel-label {
  margin-bottom: 5px;
  font-size: 11px;
  color: var(--text-3);
}
.panel-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.panel-chip {
  padding: 3px 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
}
.panel-chip:hover {
  background: var(--hover);
}
/* 选中态：和编辑器顶部 chip 用同一套强调色，一眼看出"这篇挂了这个"。 */
.panel-chip.on {
  color: #fff;
  background: var(--accent);
  border-color: var(--accent);
}

/* 「其他」组的 chip：药丸里再切一小块当删除键。
   <button> 不能嵌 <button>，所以这一组的外层是 <span>（见模板注释）。 */
.panel-tag {
  display: inline-flex;
  align-items: stretch;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 999px;
}
.panel-tag:hover {
  border-color: var(--accent);
}
.panel-tag.on {
  background: var(--accent);
  border-color: var(--accent);
}
.panel-tag-name {
  padding: 3px 4px 3px 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  background: transparent;
  border: none;
  cursor: pointer;
}
.panel-tag-name:hover {
  background: var(--hover);
}
.panel-tag.on .panel-tag-name {
  color: #fff;
}
.panel-tag.on .panel-tag-name:hover {
  background: rgba(255, 255, 255, 0.14);
}
/* 删除键：压暗常显、悬停才转红 —— 与侧栏的 .tag-op 同一套语言。
   刻意**不做成"悬停才出现"**：那会让触屏 / 触控板用户找不到它。 */
.panel-tag-x {
  width: 20px;
  padding: 0;
  font-size: 13px;
  line-height: 1;
  color: var(--text-3);
  background: transparent;
  border: none;
  cursor: pointer;
}
.panel-tag-x:hover {
  color: var(--danger);
  background: var(--hover);
}
.panel-tag.on .panel-tag-x {
  color: rgba(255, 255, 255, 0.85);
}
.panel-empty {
  font-size: 12px;
  color: var(--text-3);
}

/* 删除确认条：左边一条红边点明"这是危险动作"，但仍是面板内的一小块，
   不弹系统对话框 —— 原生 confirm() 与这套界面风格无关、还会阻塞 webview；
   面板内自绘一条，位置贴近那个 ×，用户一眼知道在确认什么。
   注意 text 会折行（要说清"影响几篇"），用 flex + min-width:0 让它撑开。 */
.panel-confirm {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 8px 10px;
  background: var(--hover);
  border: 1px solid var(--border);
  border-left: 3px solid var(--danger);
  border-radius: 8px;
}
.panel-confirm-text {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
}
.panel-confirm-del {
  flex-shrink: 0;
  padding: 4px 12px;
  font-size: 12px;
  color: #fff;
  background: var(--danger);
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.panel-confirm-del:hover {
  filter: brightness(1.05);
}
.panel-confirm-cancel {
  flex-shrink: 0;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-2);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}
.panel-confirm-cancel:hover {
  background: var(--surface);
  border-color: var(--text-3);
}
.panel-add {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.panel-input {
  flex: 1;
  min-width: 0;
  padding: 5px 10px;
  font-size: 12px;
  color: var(--text-1);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 7px;
  outline: none;
}
.panel-input:focus {
  border-color: var(--accent);
}
.panel-input::placeholder {
  color: var(--text-3);
}
.panel-add-btn {
  flex-shrink: 0;
  padding: 5px 14px;
  font-size: 12px;
  color: #fff;
  background: var(--accent);
  border: none;
  border-radius: 7px;
  cursor: pointer;
}
.panel-add-btn:hover {
  filter: brightness(1.05);
}

.content-input {
  flex: 1;
  width: 100%;
  min-height: 0;
  padding: 0;
  font-family: var(--mono);
  font-size: 15px;
  line-height: 1.9;
  color: var(--text-1);
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  tab-size: 2;
}
.content-input::placeholder {
  color: var(--text-3);
}
.preview {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
/* 锁定态：文字淡一点表示只读，但仍然可选中、可复制、可滚动。 */
.title-input.locked,
.content-input.locked {
  color: var(--text-2);
  cursor: default;
}
.placeholder,
.error {
  font-size: 13px;
  color: var(--text-3);
}
.error {
  color: var(--danger);
  margin-bottom: 10px;
}
</style>
