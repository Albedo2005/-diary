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
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import {
  deleteAttachment,
  deleteEntry,
  IMAGE_EXTS,
  listAttachments,
  listTags,
  lockAllEntries,
  MAX_IMAGE_BYTES,
  MOODS,
  openEntry,
  readAttachmentBlob,
  retireTag,
  saveAttachment,
  saveEntry,
  setEntryLocked,
  setEntryTags,
  TAG_MAX_CHARS,
  tagsOfEntry,
  toAppError,
  type Attachment,
  type Entry,
  type TagStat,
} from "../api";
import { humanDate } from "../utils/date";
import { stripAttachmentImages } from "../utils/imageMarkdown";

const props = defineProps<{
  date: string;
  /** 保存成功后通知父组件（用于刷新日历标记） */
  onSaved?: () => void;
  /**
   * 标签变更信号。侧栏删掉 / 改名了某个标签时由父组件递增，
   * 用来让这里的 chip 行与面板候选跟着刷新。
   */
  tagToken?: number;
  /**
   * 离开这一天（切日期 / 重开软件）时是否自动把日记锁上。默认 **开**。
   *
   * ⚠️ `undefined`（父组件还没读到设置）必须按"锁"处理，见 `load()`。
   *    设置存在加密库里，要等解锁才读得到 —— 把"还没拿到"当成 `false`
   *    会出现"重开软件后日记居然没锁"，与默认值相反，而且**是静默的**。
   */
  autoLockEntries?: boolean;
  /**
   * 日记锁定时，在正文里连点三下左键是否可以直接解锁（指令 15）。默认 **开**。
   *
   * ⚠️ 这一项与 `autoLockEntries` 的"`undefined` 按锁处理"**方向相反**：
   *    它是一个纯粹的可选手势，读不到设置时按**关**处理更保守 ——
   *    无非是得多点一下 🔓；反过来按开处理，会让"设置还没读回来"
   *    的那一小段时间里三击意外可用（而它恰恰是防别人误改的）。
   *    真正"老库默认开"的语义落在库里的默认值上（见 db.rs 的同名常量），
   *    这里只是"父组件还没告诉过我"时的兜底。
   */
  tripleClickUnlock?: boolean;
  /**
   * 「整个库被换掉了」信号（P2-5 恢复备份时由父组件递增）。
   *
   * 为什么必须有它：恢复是**整库替换**，而 `selected`（正在看哪天）通常没变 ——
   * 光靠 `watch(props.date)` 根本察觉不到，屏幕会一直显示**旧库**里那天的正文，
   * 用户会以为"恢复没生效"。
   * 递增这个令牌 = "别信屏幕上现在这些，去库里重读一遍"。
   *
   * ⚠️⚠️ **绝对不要改回复用 `refreshToken`。** 那个令牌每次保存都会递增
   *    （日历靠它刷"写过"的标记），而 `load()` 里有一句 `lockAllEntries()` ——
   *    两者一连上就是这个后果：**用户打几个字 → 1 秒后自动保存 → 立刻重载并重新上锁
   *    → 接着打的字全部静默丢弃**。而且它只在"同一篇里连续写两次"时才暴露，
   *    单篇一次性的冒烟测试**看不出来**，非常容易漏。
   *    「保存了」和「库被换掉了」是两件不同的事，就必须是两个令牌。
   */
  libraryToken?: number;
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

// ── 图片附件（P1 #10）──────────────────────────────────────────────────────
/** 本篇的附件（只有元信息）。缩略图区按这个列表排。 */
const attachments = ref<Attachment[]>([]);

/**
 * 附件 id → 已经取回来的图片地址（Blob URL）。
 *
 * 缓存的意义：同一张图既要在缩略图区显示、又要在放大浮层里显示，
 * 不缓存就每次点开都重新读一遍磁盘、重建一个 URL。
 *
 * ⚠️ Blob URL 会一直占着内存，必须显式 revoke：换日期、卸载组件都要
 *    （见 `releaseImageUrls`），否则每翻一天就漏一批。
 */
const imageUrls = ref<Record<number, string>>({});
/** 正在传图片（按钮转"正在上传…"、并挡住重复点击）。 */
const imageBusy = ref(false);
const imageError = ref("");
/** 被放大查看的那张图（`null` = 浮层关着）。 */
const zoomIndex = ref<number | null>(null);

/**
 * 放大浮层当前该显示的东西。
 *
 * 存的是**这张图在 attachments 里的下标**，不是一份 url 快照 —— 有了下标
 * 才谈得上“上一张 / 下一张”和“第 3 / 共 7 张”。用 computed 现算：
 * 翻页、删图、甚至某张图的地址晚一点才取回来，浮层都跟着自动更新。
 */
const zoomed = computed(() => {
  const i = zoomIndex.value;
  if (i === null) return null;
  const a = attachments.value[i];
  if (!a) return null;
  return {
    url: imageUrls.value[a.id] ?? "",
    name: a.file_name,
    index: i,
    total: attachments.value.length,
  };
});
/** 隐藏的 `<input type="file">`：点「插入图片」时由代码去点它。 */
const filePicker = ref<HTMLInputElement | null>(null);
/** 有文件拖到正文上方（用来高亮一下，否则用户不知道"能不能放这里"）。 */
const dragging = ref(false);

/* ── 缩略图排的折叠（2.3）──────────────────────────────────────────────
   图多起来一排会铺开好几行，把正文挤下去。所以默认**只占一行**：装不下的
   裁掉，行尾给一个折叠按钮，点开才铺满。

   ⚠️“装不下”是**量出来的**（scrollWidth > clientWidth），不是按张数猜的：
      同样 6 张图，窗口宽一点能排 6 列，窄一点就是 4 列。
   ⚠️ 展开状态下**不重量** —— 一换行就永远量不出“超出”，按钮会自己消失。 */
const stripRef = ref<HTMLDivElement | null>(null);
const expanded = ref(false);
const overflowing = ref(false);

function measureStrip() {
  if (expanded.value) return;
  const el = stripRef.value;
  overflowing.value = !!el && el.scrollWidth > el.clientWidth + 2;
}

function toggleStrip() {
  expanded.value = !expanded.value;
  void nextTick(measureStrip);
}

/** 一排的宽度跟着窗口走，窗口一动就得重量一次。 */
onMounted(() => window.addEventListener("resize", measureStrip));

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
 * 确认条上的那句话：把"会发生什么、不会发生什么"一次说清。
 *
 * 这一版的「删除」是**软删除**：标签从此不再出现在可选标签里，
 * 但**已经贴过它的日记照旧保留这个标签**。用户看见"删除"两个字，
 * 第一反应就是"我的日记呢" —— 必须当场把这条说死。
 * 篇数取自 `TagStat.entry_count`（后端按"写过"统计），前端不另算一份。
 */
const deleteHint = computed(() => {
  const t = pendingDelete.value;
  if (!t) return "";
  return t.entry_count > 0
    ? `移除标签「${t.name}」？它正被 ${t.entry_count} 篇日记使用 —— 移除后它不再出现在可选标签里，但那 ${t.entry_count} 篇日记仍然保留它。`
    : `移除标签「${t.name}」？目前没有日记在用它。`;
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
 * 这篇日记算不算"写过"。
 *
 * ⚠️ 必须与后端 `db::has_content_sql()` 保持完全一致，否则会出现
 *    "编辑器认为写过、日历认为没写"这类界面自相矛盾的状态。
 *
 * 2026-09-21 起它包含两半：**正文非空白，或者这篇已经挂着图片附件**。
 * 后端同一天也改成了同一条规则（用户拍板：允许在一篇还没写正文的日记里插
 * 图片，并且把附件也算作"写过"）。所以这里必须跟着改 —— 否则一篇只有图片的
 * 日记会出现"日历上有标记、心情和标签却点不动"。
 * 刻意只留正文和附件、不看标题：只打了标题没写正文不算写完一篇。
 */
function hasContent(): boolean {
  return content.value.trim().length > 0 || attachments.value.length > 0;
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

/**
 * 三击左键解锁（指令 15）。
 *
 * ⚠️ 只在**锁定态**参与，未锁定时第一行就 `return` ——
 *    "连点三下选中一整段"是浏览器原生行为，一个字节都不能改。
 *    挂监听可以，但要拦、要改默认行为的地方一处都没有。
 * ⚠️ 第 3 下必须 `preventDefault()`：否则 `readonly` 的 textarea 会顺势
 *    全选，解锁的一瞬间满屏高亮，用户会以为"解锁把内容搞乱了"。
 * ⚠️ 监听只挂正文 `textarea`，**不挂 `.editor` 整块** ——
 *    挂整块的话，在「🔒 已锁定」按钮 / 心情按钮 / 标签 × 上三击会**连带触发**，
 *    与按钮自身的点击打架（等于瞬间连点两下开关）。
 * ⚠️ 一行都不碰 `contextmenu`：正文右键菜单必须原样保留。
 */
let lastClick = 0;
let streak = 0;

function onContentMouseDown(e: MouseEvent) {
  if (!props.tripleClickUnlock) return;
  if (!locked.value) return;
  if (e.button !== 0) return;
  const now = Date.now();
  // 相邻两下间隔超过 500ms 就重新计数 —— 慢速点三下不算。
  streak = now - lastClick <= 500 ? streak + 1 : 1;
  lastClick = now;
  if (streak < 3) return;
  streak = 0;
  e.preventDefault();
  // 复用既有路径：它内部已经处理了"先保存、后锁定"的次序，
  // 并用**后端返回值**回填 locked —— 别另写一条解锁路径。
  void toggleLock();
  emit("notice", "已解锁");
}

async function load() {
  loading.value = true;
  errorText.value = "";
  cancelPendingSave();
  try {
    // 先把所有日记锁上，再读要打开的这一篇。
    // 于是"切换日期"和"重新打开软件"都会让上一篇自动回到锁定状态。
    //
    // 指令 14 起这一步**受设置控制**：设置页【安全】里可以关掉它
    // （想回头补一句时不必反复解锁）。这里只让"锁定"这一步可能不执行，
    // ⚠️ 绝不改变"保存永远在锁定之前"的次序 —— 见下面 watch(props.date)。
    //
    // ⚠️ `undefined`（父组件还没拿到设置）一律按**锁**处理：
    //    把"还没读出来"当成 false，会出现"重开软件后日记居然没锁"。
    if (props.autoLockEntries !== false) await lockAllEntries();
    // openEntry 是纯读取：没有内容时返回空模板（id = 0），不会写库。
    // 所以"点开日历"不会把这一天变成"写过"。
    const e = await openEntry(props.date);
    entry.value = e;
    title.value = e.title;
    locked.value = e.locked;
    // 2.2 一度把图片以 `![名](attachments/…)` 写进正文；2.3 起图片只挂在
    // “这一天”上，正文里不再留这种语法。这里把旧记录里残留的那段清掉 ——
    // **图片本体不受影响**（附件是按 entry_id 挂着的，不靠正文里那段字
    // 指认），它在上面那排缩略图里的位置照旧。清完顺手存一次，
    // 免得下次打开又冒出来。
    const rawBody = e.content_md;
    content.value = stripAttachmentImages(rawBody);
    const legacyCleaned = content.value !== rawBody;
    mood.value = e.mood;
    // 先清空再读：读失败时宁可"看不到标签"，也不能把上一天的标签
    // 留在屏幕上冒充这一天的（那会让用户以为标签串了）。
    tags.value = [];
    syncedTags = [];
    tagInput.value = "";
    panelOpen.value = false;
    pendingDelete.value = null;
    // 附件同理：先清空（连同已经建好的 Blob URL 一起释放），再读这一天的。
    // 读失败时宁可"看不到图"，也不能把上一天的图留在屏幕上冒充这一天的。
    await loadAttachments();
    await loadTags();
    dirty = false;
    saveState.value = "";
    // 只有真的清掉过残留、且这篇没被锁时才补写一次库。
    if (legacyCleaned && !locked.value) {
      dirty = true;
      await flush();
    }
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
// ── 图片附件（P1 #10）──────────────────────────────────────────────────────

/**
 * 放掉所有已经建好的 Blob URL。
 *
 * ⚠️ 必须显式 revoke：Blob URL 会让那份数据一直留在内存里，浏览器不会
 *    因为"没人引用了"就回收。换日期、卸载组件都要调（否则每翻一天漏一批）。
 */
function releaseImageUrls() {
  for (const url of Object.values(imageUrls.value)) URL.revokeObjectURL(url);
  imageUrls.value = {};
}

/** 取某张图的显示地址；没取过就去后端读一次并缓存。 */
async function urlOf(a: Attachment): Promise<string | null> {
  const cached = imageUrls.value[a.id];
  if (cached) return cached;
  try {
    const blob = await readAttachmentBlob(a.id, a.mime);
    const url = URL.createObjectURL(blob);
    imageUrls.value = { ...imageUrls.value, [a.id]: url };
    return url;
  } catch (e) {
    // 单张读不出来不该让整块区域炸掉：记一句话，其余照常显示。
    imageError.value = toAppError(e).message;
    return null;
  }
}

/** 读这一天的附件列表。 */
async function loadAttachments() {
  releaseImageUrls();
  zoomIndex.value = null;
  expanded.value = false;
  overflowing.value = false;
  imageError.value = "";
  try {
    attachments.value = await listAttachments(props.date);
    // 顺手把缩略图取回来：一篇日记通常只有几张图，界面上就该一眼看到。
    for (const a of attachments.value) void urlOf(a);
  } catch (e) {
    attachments.value = [];
    imageError.value = toAppError(e).message;
  }
  // 图变了、行里能装几张也跟着变，量一次才知道要不要给折叠按钮。
  void nextTick(measureStrip);
}

/** 打开文件选择框（锁定 / 正在上传时不给点）。 */
function pickImage() {
  if (locked.value || imageBusy.value) return;
  filePicker.value?.click();
}

/**
 * 存一张图，挂到“这一天”上。
 *
 * 只往“这一天”上挂，**不碰正文** —— 2.3 起正文里没有任何图片语法，
 * 也就不存在“上传失败却在正文里留下一行死引用”这种事。
 *
 * 为什么用原生 `<input type="file">` 而不是 Tauri 的 dialog 插件：
 * 这个项目的构建环境**拉不到任何新依赖**，而这里真正需要的只是"字节"
 * （`save_attachment` 要的就是字节，不是路径），原生选择框直接给 `File`
 * 对象（名字 + 字节），弹的也还是系统文件选择框 —— 体验一样，
 * 却不需要多一个插件（见生产日志的坑表）。
 */
async function uploadOne(file: File) {
  imageError.value = "";
  if (locked.value) {
    imageError.value = "这篇日记已锁定，先解锁再插入图片";
    return;
  }

  // 前端先把最明显的两类错误挡掉（省得白传一份出去）。真正的判据在后端：
  // 扩展名 + MIME + 文件头魔数，三样都要对上。
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!IMAGE_EXTS.includes(ext)) {
    imageError.value = `只支持 ${IMAGE_EXTS.join(" / ")}，这个是 ${
      ext ? "." + ext : "(没有后缀的文件)"
    }`;
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    imageError.value = `单张图片上限 ${MAX_IMAGE_BYTES / 1024 / 1024} MB，这张是 ${(
      file.size /
      1024 /
      1024
    ).toFixed(1)} MB`;
    return;
  }

  imageBusy.value = true;
  try {
    const saved = await saveAttachment(props.date, file);
    attachments.value = [...attachments.value, saved];
    // 立刻把缩略图取回来，不然要等下次打开这一天才看得见。
    await urlOf(saved);
    // 刚插进来的那张必须让人看见：一排装不下就先展开 —— 否则“已插入图片”
    // 的提示说完了，图却藏在被裁掉的那半排里。
    void nextTick(() => {
      measureStrip();
      if (overflowing.value) expanded.value = true;
    });
    emit("notice", `已插入图片「${saved.file_name}」`);
  } catch (e) {
    imageError.value = toAppError(e).message;
  } finally {
    imageBusy.value = false;
  }
}

/** 文件选择框 / 拖拽的公共入口，支持一次选多张。 */
async function uploadFiles(files: FileList | File[] | null) {
  if (!files) return;
  for (const f of Array.from(files)) {
    // **串行**：并发上传时两条记录的自增 id 顺序会和用户选的顺序错开，
    // 插进正文的顺序也跟着乱。
    await uploadOne(f);
  }
}

/** 把图片语法插到正文光标处（正文永远是 Markdown 原文，这是 V1 约束）。 */
/**
 * Ctrl+V / 右键粘贴。
 *
 * 剪贴板里带着图片文件时，把这次粘贴**整个接管**（`preventDefault`）：
 * 图只挂到这一天，不往正文里走。纯文字的粘贴原样放行 —— 这一段只处理图，
 * 一个字都不碰用户的文字。
 *
 * 系统截图（Win+Shift+S 那种）给的是一个**没有文件名**的 File，所以这里
 * 给它起“粘贴-20260921-171031.png”这样的名字；从资源管理器复制来的文件
 * 带着真名字，就用真名字（见 renamePasted）。
 */
function onPaste(ev: ClipboardEvent) {
  if (locked.value) return; // 只读时别拦，交给浏览器的默认行为
  const files = pastedFiles(ev.clipboardData);
  if (files.length === 0) return; // 纯文字粘贴 → 放行
  ev.preventDefault();
  void uploadFiles(files.map(renamePasted));
}

/** 从剪贴板里挑出图片文件（items 更准，退到 files）。 */
function pastedFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const f = item.getAsFile();
    if (f) fromItems.push(f);
  }
  if (fromItems.length > 0) return fromItems;
  return Array.from(data.files ?? []).filter((f) =>
    f.type.startsWith("image/")
  );
}

/** 粘贴来的图按 MIME 定后缀 —— 走到这一步的图往往连名字都没有。 */
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * 给粘贴来的图起名。
 *
 * 三种情况：
 *   · 截图（`image.png` / 空名 / 压根没有后缀）→ 起“粘贴-时间戳”；
 *   · 从资源管理器复制的真文件 → **保留原名**，那是用户自己认识的名字。
 * 同一批粘贴多张时，第二张起带 -2 / -3 后缀，免得名字撞在一起。
 */
function renamePasted(file: File, i: number): File {
  const hasExt = /\.[a-z0-9]+$/i.test(file.name);
  const generic = !hasExt || /^(image|blob|screenshot|粘贴)[-.]/i.test(file.name);
  if (!generic) return file;

  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const ext = MIME_EXT[file.type] ?? "png";
  const tail = i === 0 ? "" : `-${i + 1}`;
  return new File([file], `粘贴-${stamp}${tail}.${ext}`, { type: file.type });
}

/** 文件选择框选中之后：交给公共上传流程，然后把选择框清空。 */
function onFilesPicked(ev: Event) {
  const input = ev.target as HTMLInputElement;
  void uploadFiles(input.files).finally(() => {
    // ⚠️ 必须清空：不清空的话，第二次选**同一个文件**不会再触发 change
    //    （值没变），用户会以为按钮坏了。
    input.value = "";
  });
}

/** 有文件拖到编辑区上方。用来高亮一下提示"可以放这里"。 */
function onDragOver(ev: DragEvent) {
  if (locked.value) return;
  if (ev.dataTransfer?.types.includes("Files")) {
    // 不 preventDefault 的话浏览器会把这次拖拽当成"打开这个文件"，
    // 整个页面被那张图替换掉。
    ev.preventDefault();
    dragging.value = true;
  }
}

function onDragLeave() {
  dragging.value = false;
}

async function onDrop(ev: DragEvent) {
  dragging.value = false;
  if (locked.value) return;
  const files = ev.dataTransfer?.files;
  if (!files || files.length === 0) return;
  ev.preventDefault();
  await uploadFiles(files);
}

/** 删一张图。 */
async function removeAttachment(a: Attachment) {
  imageError.value = "";
  try {
    await deleteAttachment(a.id);
    const url = imageUrls.value[a.id];
    if (url) {
      URL.revokeObjectURL(url);
      const rest = { ...imageUrls.value };
      delete rest[a.id];
      imageUrls.value = rest;
    }
    if (url && zoomed.value?.url === url) zoomIndex.value = null;
    attachments.value = attachments.value.filter((x) => x.id !== a.id);
    // ⚠️ 删完必须先收起、再重量（P2-1）。
    //   内容变少了，继续停在展开态本身就没有意义；更要紧的是 measureStrip
    //   有一道"展开态不测量"的守卫（那行是对的、不能删），不先收起就永远量不出
    //   新结果，折叠按钮会赖着不走 —— 用户实测的"要点两下才消失"就是这么来的。
    //   照抄 loadAttachments() 的做法，别引入新风格。
    expanded.value = false;
    void nextTick(measureStrip);
    emit("notice", `已删除图片「${a.file_name}」`);
  } catch (e) {
    imageError.value = toAppError(e).message;
  }
}

/**
 * 点缩略图：取到地址后在中间放大显示。
 *
 * ⚠️ 先 await 取图、再开浮层：反过来的话浮层会先空一下再蹦出画面。
 */
async function zoomIn(a: Attachment) {
  await showZoom(attachments.value.findIndex((x) => x.id === a.id));
}

/** 打开第 i 张（先把图取回来，避免浮层闪一下空白）。 */
async function showZoom(i: number) {
  if (i < 0 || i >= attachments.value.length) return;
  await urlOf(attachments.value[i]);
  zoomIndex.value = i;
}

/**
 * 上一张 / 下一张。
 *
 * **首尾相接**（第 1 张往左是最后一张）：两端都不留按不动的死按钮，
 * 图少的时候也不会出现"点了没反应"。
 */
async function stepZoom(delta: number) {
  const i = zoomIndex.value;
  if (i === null) return;
  const n = attachments.value.length;
  if (n === 0) return;
  await showZoom((i + delta + n) % n);
}

function closeZoom() {
  zoomIndex.value = null;
}

function onZoomKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape") closeZoom();
  else if (ev.key === "ArrowLeft") {
    ev.preventDefault();
    void stepZoom(-1);
  } else if (ev.key === "ArrowRight") {
    ev.preventDefault();
    void stepZoom(1);
  }
}

/**
 * 放大浮层开着的时候才挂 Esc 监听，关掉立刻摘掉 —— 与标签面板同一套作业，
 * 不留常驻的全局监听。
 */
watch(zoomIndex, (open, _old, onCleanup) => {
  if (open === null) return;
  document.addEventListener("keydown", onZoomKeydown);
  onCleanup(() => document.removeEventListener("keydown", onZoomKeydown));
});

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
 * 确认"删除"：让这个标签退休。
 *
 * ⚠️ 后端 `retire_tag` **不删标签行、更不碰日记**：只把 `retired` 置 1，
 *    于是它从"可选列表"里消失，而**已经贴过它的日记照旧显示它**。
 *    返回"有几篇日记挂着它"，用来在提示里说一句实话。
 *
 * 后端是幂等的（标签不存在 / 已经退休都不报错），连点两下不会出错。
 */
async function confirmDelete() {
  const t = pendingDelete.value;
  if (!t) return;
  try {
    const affected = await retireTag(t.id);
    /*
      ⚠️ 这里**不再**把 t.name 从 tags / syncedTags 里摘掉（上一版会摘）。
      上一版后端是真删：库里那条 entry_tag 随级联没了，前端不清就会拿旧名单
      去提交，而 set_entry_tags 遇到库里不存在的名字会新建同名标签 → 白删。
      现在后端只打了个退休标记，**本篇的关联行还在**，tags_of_entry 照样
      返回它。前端要是自作主张摘掉，下一次 syncTags() 提交的名单就比库里
      少一个 —— 那反而真的把用户这篇日记的标签删掉了。
      所以：本地状态原样不动，只重读候选列表。
    */
    pendingDelete.value = null;
    // 候选变了（退休的那个从「其他」里消失），重读全库标签。
    allTags.value = await listTags();
    // 与侧栏同一句话：先答"我的日记呢"，再报篇数。
    emit(
      "notice",
      affected > 0
        ? `已移除标签「${t.name}」——以后不再出现在可选标签里；另有 ${affected} 篇日记仍保留它`
        : `已移除标签「${t.name}」（本来就没有日记在用它）`
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
 * 库被换掉了（恢复备份）→ 整篇重载。
 *
 * ⚠️ 这里**不先 flush**：此刻屏幕上的内容属于**已经被替换掉的那个库**，
 *    再往新库里写就是拿旧数据污染新库。父组件在恢复**之前**已经 flush 过一次
 *    （见 App.vue 的 doRestore），所以这里直接重读就行。
 *
 * ⚠️ 只认 `libraryToken`，**不许**挂在 `refreshToken` 上（理由见 props 里的说明）。
 */
watch(
  () => props.libraryToken,
  () => void load()
);

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

// 首屏：load() 里那句（受设置控制的）lockAllEntries() 顺带实现了
// "关掉软件再打开，所有日记都是锁的" —— 指令 14 把开关交给用户后，
// 关掉的人重开软件不会再被自动锁上。
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
  window.removeEventListener("resize", measureStrip);
  // 面板的全局监听也要摘掉，避免反复挂载累积。
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  document.removeEventListener("keydown", onDocKeydown);
  // 图片的 Blob URL 也要放掉，否则每换一天就漏一批内存。
  releaseImageUrls();
  // 组件卸载前把未落库的内容写下去。
  if (dirty) void flush();
});

/**
 * 把"落库"这一个动作交给父组件调度 —— 目前只有一个调用方：App.vue 的 doLock()。
 *
 * 为什么需要它（P2-4）：
 *   点「锁定」时 App.vue 会先 lockVault()，库一锁、本组件就随主界面一起卸载，
 *   而卸载时那句 `if (dirty) void flush()` **撞在已锁的库上必然失败**。
 *   加上正文是 1000ms 防抖保存 ⇒ "点锁定前最后 1 秒打的字"会静默消失。
 *   ⇒ 父组件必须在**锁库之前**先调一次这里。
 *
 * 自己不做任何判断：没有脏内容时 flush() 内部直接 return，重复调也无害。
 * flush() 内部已经把失败写进 saveState，不会往外抛。
 */
defineExpose({ flushNow: () => flush() });
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
      <div class="right">
        <!--
          插入图片。原生 <input type="file">（隐藏）配一个普通按钮去点它 ——
          不用 Tauri 的 dialog 插件，理由见 uploadOne 的注释。
          锁定时禁用：后端也会拒（附件的写操作与正文同口径）。
        -->
        <button
          class="toggle"
          :disabled="locked || imageBusy"
          :title="locked ? '这篇日记已锁定，先解锁' : '插入一张图片（也可以拖进来，或直接 Ctrl+V 粘贴）'"
          @click="pickImage"
        >
          {{ imageBusy ? "正在上传…" : "🖼 插入图片" }}
        </button>
        <button
          class="toggle"
          :class="{ on: locked }"
          :title="locked ? '解锁后可继续修改' : '锁定后正文只读，排版原样保留'"
          @click="toggleLock"
        >
          {{ locked ? "🔒 已锁定" : "🔓 锁定" }}
        </button>
      </div>
    </header>

    <!--
      隐藏的文件选择框。它只是个"由代码点的按钮"，不参与版面。
      accept 让系统选择框默认只列图片；multiple 允许一次选多张。
    -->
    <input
      ref="filePicker"
      class="file-picker"
      type="file"
      accept="image/png,image/jpeg,image/gif,image/webp"
      multiple
      @change="onFilesPicked"
    />

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
                  :title="`移除标签「${t.name}」（以后不再出现在可选标签里；已写过的日记仍保留它）`"
                  @click="askDelete(t)"
                >
                  ×
                </button>
              </span>
            </div>
          </div>

          <!--
            移除确认条。
            ⚠️「其他」组的 × **不立即生效** —— 它虽然碰不到正文，但会改掉
               "这个标签以后还出不出现在可选列表里"，而且它就贴在一排可点的
               chip 旁边，误触概率不低。侧栏那处不做确认，是因为它是**专门的**
               管理区、动作单一；这里混在"选择标签"的动作里，必须多一道手。
            （移除本身是**软**的：标签不在列表里了，但已写过的日记仍保留它。
              所以这条确认条主要是防误触，而不是防"不可逆"。）
          -->
          <div v-if="pendingDelete" class="panel-confirm">
            <span class="panel-confirm-text">{{ deleteHint }}</span>
            <button
              type="button"
              class="panel-confirm-del"
              @click="confirmDelete"
            >
              移除
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

      <div
        v-if="attachments.length > 0"
        class="shot-wrap"
        :class="{ expanded }"
      >
        <div ref="stripRef" class="shot-row" :class="{ expanded }">
          <span v-for="a in attachments" :key="a.id" class="shot">
            <button
              type="button"
              class="shot-img"
              :title="`点击放大：${a.file_name}`"
              @click="zoomIn(a)"
            >
              <img
                v-if="imageUrls[a.id]"
                :src="imageUrls[a.id]"
                :alt="a.file_name"
              />
              <span v-else class="shot-loading">…</span>
            </button>
            <button
              type="button"
              class="shot-x"
              :disabled="locked"
              :title="
                locked ? '这篇日记已锁定，先解锁' : `删除图片「${a.file_name}」`
              "
              @click="removeAttachment(a)"
            >
              ×
            </button>
          </span>
        </div>

        <!--
          折叠按钮（2.3）。只在**真的装不下**时出现；点一下铺满，
          再点收成一行。它贴着这一行的最右侧 —— 也就是"这里还有更多"的位置。
        -->
        <button
          v-if="overflowing"
          type="button"
          class="shot-toggle"
          :title="
            expanded
              ? `收起（这一篇共 ${attachments.length} 张图）`
              : `展开全部 ${attachments.length} 张图`
          "
          @click="toggleStrip"
        >
          {{ expanded ? "⌃" : "⌄" }}
        </button>
      </div>

      <p v-if="imageError" class="error">{{ imageError }}</p>

      <!--
        锁定与编辑共用同一个 textarea，**刻意不切换成渲染视图**。
        看得见的就是将要保存的原文：换行、空格、缩进全部原样，
        所以"锁定"不会改变排版。只读靠 readonly（不是 disabled）——
        disabled 的输入框不能选中、不能滚动，想复制一段都做不到。
      -->
      <textarea
        v-model="content"
        class="content-input"
        :class="{ locked, dragging }"
        placeholder="今天发生了什么…"
        spellcheck="false"
        :readonly="locked"
        @mousedown="onContentMouseDown"
        @compositionstart="onCompositionStart"
        @compositionend="onCompositionEnd"
        @keydown="onKeydown"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop="onDrop"
        @paste="onPaste"
      />
    </template>

    <!--
      放大查看：应用内居中浮层（← → 翻页、点空白处 / 按 Esc 关闭）。
      刻意**不**另开一个系统窗口 —— 那要注册新的 webview 窗口和对应权限，
      而这里要的只是"把这张图看清楚"。
    -->
    <div v-if="zoomed" class="zoom-mask" @click="closeZoom">
      <!-- 整块 stage 上的点击不再冒泡到遮罩：点图/点按钮都不关浮层。 -->
      <div class="zoom-stage" @click.stop>
        <button
          type="button"
          class="zoom-nav"
          :disabled="zoomed.total < 2"
          title="上一张（←）"
          @click="stepZoom(-1)"
        >
          ‹
        </button>
        <img
          v-if="zoomed.url"
          class="zoom-img"
          :src="zoomed.url"
          :alt="zoomed.name"
        />
        <span v-else class="zoom-loading">读取中…</span>
        <button
          type="button"
          class="zoom-nav"
          :disabled="zoomed.total < 2"
          title="下一张（→）"
          @click="stepZoom(1)"
        >
          ›
        </button>
      </div>
      <p class="zoom-tip">
        {{ zoomed.name }} · 第 {{ zoomed.index + 1 }} / {{ zoomed.total }} 张 ·
        ← → 翻页，Esc 或点空白处关闭
      </p>
    </div>
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

/* ── 图片附件（P1 #10）───────────────────────────────────────────────── */

/* 头部右侧：「插入图片」和「锁定」排在一起。 */
.right {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 隐藏的文件选择框。它只是个"由代码点的按钮"，不参与版面。 */
.file-picker {
  display: none;
}

/* ── 附件缩略图区（P1 #10）────────────────────────────────────────────
   图片只挂在这一天上，这里就是它唯一露脸的地方。默认**只占一行**：
   装不下的裁掉，行尾给折叠按钮（要不要给，量出来的，见 measureStrip）。

   ⚠️ 内边距不是装饰：删除键（×）挂在缩略图右上角 −6px 处，而
      overflow:hidden 是照**内边距盒**裁的 —— 不留这 8px，第一排的 × 会被切掉。 */
.shot-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0;
}
/* 展开后是好几行，折叠按钮顶到最上面去，别跟着正中。 */
.shot-wrap.expanded {
  align-items: flex-start;
}
.shot-row {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: nowrap;
  gap: 8px;
  padding: 8px 8px 2px 0;
  overflow: hidden;
}
.shot-row.expanded {
  flex-wrap: wrap;
  overflow: visible;
}
/* 折叠按钮：贴着这一行的最右侧，与缩略图等高。 */
.shot-toggle {
  flex: 0 0 auto;
  width: 22px;
  height: 84px;
  padding: 0;
  font-size: 13px;
  line-height: 1;
  color: var(--text-2);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
}
.shot-toggle:hover {
  border-color: var(--accent);
  color: var(--text-1);
}

.shot {
  position: relative;
  display: inline-flex;
  /* 一排装不下时也不能被 flex 压扁 —— 缩略图该多大就多大。 */
  flex: 0 0 auto;
}

.shot-img {
  width: 84px;
  height: 84px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  cursor: pointer;
  overflow: hidden;
}

.shot-img:hover {
  border-color: var(--accent);
}

.shot-img img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.shot-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--text-3);
}

/* 删除键贴在缩略图右上角（与标签 chip 的 × 同一套观感）。 */
.shot-x {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface);
  color: var(--text-2);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.shot-x:hover:not(:disabled) {
  border-color: var(--danger);
  color: var(--danger);
}

.shot-x:disabled {
  opacity: 0.45;
  cursor: default;
}

/* 有文件拖到正文上方时给它一圈提示 —— 否则用户不知道"这里能放"。 */
.content-input.dragging {
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* 放大查看：铺满窗口的遮罩 + 居中大图（点遮罩关，点图不关）。 */
.zoom-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 4vh 4vw;
  background: rgba(0, 0, 0, 0.72);
  cursor: zoom-out;
}

/* 图 + 左右翻页按钮排成一行。 */
.zoom-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 20px;
  max-width: 100%;
}
.zoom-nav {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  padding: 0;
  font-size: 24px;
  line-height: 1;
  color: #fff;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 50%;
  cursor: pointer;
}
.zoom-nav:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.24);
}
.zoom-nav:disabled {
  opacity: 0.3;
  cursor: default;
}
.zoom-loading {
  font-size: 13px;
  color: #fff;
  opacity: 0.8;
}
/* ⚠️ 宽度按视口算，不是 max-width:100% —— 后者在这种 flex 行里会绕一圈
   依赖父宽，结果是要么溢出要么缩成一条。 */
.zoom-img {
  max-width: calc(100vw - 200px);
  max-height: 78vh;
  object-fit: contain;
  border-radius: 6px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  cursor: default;
}

.zoom-tip {
  margin: 0;
  font-size: 12px;
  color: #fff;
  opacity: 0.85;
}
</style>
