<script setup lang="ts">
/**
 * 筛选页（P2-7）：按 **标签 · 心情 · 时间** 捞日记。
 *
 * 形态是从用户 2026-09-23 给的那张 B站 番剧筛选页截图里借来的**三件事**
 * （原话"我觉得 B站 这个不赖"）：
 *   ① **一行一个维度**（排序 / 标签 / 心情 / 时间）：最左边是维度名，右边全是小药丸；
 *   ② **选中的那个高亮** —— 用的是**本软件自己的强调色** `--accent`，
 *      ⛔ 没有照抄 B站 的红色；
 *   ③ **选项多的那一行收进"更多"** —— ⚠️ **只有标签行需要**（它的数量没有上限），
 *      心情 5 个 / 排序 2 个 / 时间 5 个，加折叠只会让每次都得先点开。
 *
 * 三条口径（用户四问四答的结果）：
 *   * **条件不留**：切走再回来是刚打开的样子。做法是——**什么都不做**：
 *     条件就住在这几个 `ref` 里，切页时本组件被 `v-if` 卸载，条件自然没了。
 *     ⛔ 不要为了"顺手保住它"去写 `localStorage`（标签名属于"你写过什么"，
 *     `localStorage` 只许存界面偏好），⛔ 也不要把它提到 `App.vue`。
 *   * **一进来就有一屏内容**（不是空页面）⇒ 挂载时无条件查一次。
 *   * 排序**只有两个选项**（最近优先 / 最早优先）。⛔ 不做"按字数""按心情"排序 ——
 *     心情那五个是**并列的编号、不是刻度**，一排序就会出现"哪个心情算高"的荒唐问题。
 *
 * ⚠️ 本页**不新增任何"写"的能力**：最下面那块「标签管理」用的是**现成的**
 *    改名（✎）/ 退役（✕），本页只负责把它们从日历那边**挪个位置**
 *    （日历下方那块地按用户的意思**先空着**，不塞任何东西）。
 * ⚠️ 后端的 `filter_entries` 是**纯读**的，永远不写库。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import {
  filterEntries,
  listTags,
  MOODS,
  renameTag,
  retireTag,
  TAG_MAX_CHARS,
  toAppError,
  type FilterHit,
  type FilterResult,
  type TagStat,
} from "../api";
import { humanDate, shiftDate, todayKey, toDateKey } from "../utils/date";

const props = defineProps<{
  /** 标签被别处改动（编辑器加/撤了标签）时由父组件递增 */
  tagToken: number;
}>();

const emit = defineEmits<{
  /** 点一条结果 → 跳到那天写日记（与搜索页同一套动作） */
  (e: "open", date: string): void;
  /** 给用户的一句话反馈（由 App.vue 弹 toast） */
  (e: "notice", message: string): void;
  /** 本页改动了标签（改名 / 退役）⇒ 编辑器也要跟着刷新 */
  (e: "tags-changed"): void;
}>();

// ---------------------------------------------------------------------------
// 条件（全部住在这里，⛔ 不落盘、不提到外面）
// ---------------------------------------------------------------------------

/** 选中的标签 **id**（⛔ 不是名字：名字能改，id 不会）。多个之间是**并集**。 */
const tagIds = ref<number[]>([]);
/** 选中的心情编号（1~5）。多个之间是**并集**；与标签之间是**交集**。 */
const moods = ref<number[]>([]);
type RangeKey = "all" | "7d" | "30d" | "year" | "custom";
const range = ref<RangeKey>("all");
const customFrom = ref("");
const customTo = ref("");
/** 排序：`true`＝最近优先（默认）/ `false`＝最早优先。 */
const recentFirst = ref(true);

const tagsExpanded = ref(false);
/** 下面那块「标签管理」展不展开。默认收起 —— 它是"管理"，不是"筛选"。 */
const manageOpen = ref(false);
const result = ref<FilterResult | null>(null);
const errorText = ref("");
const loading = ref(false);

/**
 * 时间维度换算成两个日期（`null` ＝ 不限）。
 *
 * ⚠️ "今天是哪天"**由前端算好再传**，后端不自己取系统时间 —— 与 `stats` / `recap` 同款。
 * ⚠️ 减天数走 `shiftDate()`（`utils/date.ts`）：**跨月跨年由 `Date` 自己进位**，
 *    全项目只有那一处实现。⛔ 别在这里手写 `m - 1` 那种日期算术。
 * ⚠️ "今年"是 `01-01` 到**今天**，不是到 12-31 —— 还没到那天的日记不可能存在。
 */
function rangeBounds(): { from: string | null; to: string | null } {
  const today = todayKey();
  if (range.value === "7d") return { from: shiftDate(today, -6), to: today };
  if (range.value === "30d") return { from: shiftDate(today, -29), to: today };
  if (range.value === "year") {
    return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
  if (range.value === "custom") {
    // 只填了一头也照常能用（＝从某天起 / 到某天止）。
    // `from > to` 由后端返回空结果、不报错 —— 用户正在输日期，中间态就是这样。
    return { from: customFrom.value || null, to: customTo.value || null };
  }
  return { from: null, to: null };
}

async function run() {
  loading.value = true;
  try {
    const { from, to } = rangeBounds();
    result.value = await filterEntries({
      tags: tagIds.value,
      moods: moods.value,
      from,
      to,
      recentFirst: recentFirst.value,
    });
    errorText.value = "";
  } catch (e) {
    errorText.value = toAppError(e).message;
  } finally {
    loading.value = false;
  }
}

/**
 * 任何一项条件变了就重查。
 *
 * ⚠️ `tagIds` / `moods` 一律**整个换掉**（`[...old, x]`）而不是 `push` ——
 *    ref 里数组原地改，watcher 看不见。
 */
watch([tagIds, moods, range, customFrom, customTo, recentFirst], () => void run());

/** 点一下**已经选中**的 → **取消它**（这比每行再放个"全部"更省事，也更好懂）。 */
function toggleTag(id: number) {
  tagIds.value = tagIds.value.includes(id)
    ? tagIds.value.filter((x) => x !== id)
    : [...tagIds.value, id];
}

function toggleMood(v: number) {
  moods.value = moods.value.includes(v)
    ? moods.value.filter((x) => x !== v)
    : [...moods.value, v];
}

/** 有没有选任何条件。决定"空结果"那句该说哪一句。 */
const hasCondition = computed(
  () =>
    tagIds.value.length > 0 ||
    moods.value.length > 0 ||
    range.value !== "all" ||
    !!customFrom.value ||
    !!customTo.value
);

/**
 * 「清空条件」：回到**刚打开的样子** —— 三个维度都不限，**排序也回默认**。
 *
 * ⚠️ 排序是"什么都不选"的一部分吗？指令的原话是"回到'**什么都没选**、按排序列全部'"。
 *    这里按最直白的读法做：**连排序一起复位**，于是这一按的效果就是
 *    "整条筛选条回到出厂状态"，不会出现"按钮叫清空条件、可还亮着一颗药丸"。
 *    要改成"保留排序"是一行的事（把最后那句删掉即可）。
 */
function clearAll() {
  tagIds.value = [];
  moods.value = [];
  range.value = "all";
  customFrom.value = "";
  customTo.value = "";
  recentFirst.value = true;
}

/** 结果被上限截断了吗。⚠️ 看 `total`，⛔ 别拿 `hits.length === limit` 去猜。 */
const truncated = computed(
  () => !!result.value && result.value.total > result.value.hits.length
);

/** 空结果时的那句话 —— **照原文抄**，⛔ 别自由发挥。 */
const emptyMessage = computed(() =>
  hasCondition.value
    ? "没有符合条件的日记。试试少选几个条件。"
    : "还没写过日记。"
);

/** 一条结果最多显示几个标签，多的折成 `+N`。 */
const TAGS_PER_ROW = 4;
const extraTags = (h: FilterHit) => h.tags.length - TAGS_PER_ROW;

// ---------------------------------------------------------------------------
// 标签行折起来（"更多"）
// ---------------------------------------------------------------------------

const pillsRef = ref<HTMLElement | null>(null);
const tagsNeedMore = ref(false);
let resizeObserver: ResizeObserver | null = null;

/**
 * 量一下：标签行**折起来之后是不是还被切着**？是 ⇒ 说明它有两行以上，该给"更多"。
 *
 * ⚠️ **为什么不按"标签个数"猜**：一行装得下几个取决于**这一行有多宽**
 *    （窗口宽度、左边那块留白都算进去），任何个数阈值都必然在某档宽度上是错的。
 * ⚠️ **为什么用 `ResizeObserver` 而不是只听 `window.resize`**：容器宽度还会因为
 *    **布局内部的变化**而变，那些变化根本不触发 window 事件。量出来的状态必须
 *    有个明确的"布局变了"通知点，这里就是它。
 */
function measureTags() {
  const el = pillsRef.value;
  if (!el) return;
  tagsNeedMore.value = el.scrollHeight > el.clientHeight + 1;
}

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    // 展开状态下没有限高，量出来永远是"没超" ⇒ 只在不展开时量。
    if (!tagsExpanded.value) measureTags();
  });
  if (pillsRef.value) resizeObserver.observe(pillsRef.value);
  void nextTick(measureTags);
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

function toggleTags() {
  tagsExpanded.value = !tagsExpanded.value;
  // 收起来之后要重新量（展开时量不出真相）。
  if (!tagsExpanded.value) void nextTick(measureTags);
}

// ---------------------------------------------------------------------------
// 标签管理（从日历那边整块搬过来的，默认收起）
//
// ⚠️ 两个 ✕ 语义**完全不同**，别弄混：
//    编辑器里的 `×` ＝ 从**这一篇**上摘掉这个标签；
//    这里的 `✕`    ＝ 让这个标签**退役**（以后不再出现在列表里，已写过的日记仍保留它）。
//    这里搬走的是**后者**，悬停说明也原样带过来了。
// ---------------------------------------------------------------------------

const tags = ref<TagStat[]>([]);
const tagError = ref("");
/** 正在改名的那条（`null` ＝ 没有）。同一时刻只允许一条。 */
const editingId = ref<number | null>(null);
const editName = ref("");
const tagBusy = ref(false);

async function loadTags() {
  try {
    const list = await listTags();
    tags.value = list;
    // 列表里已经没了的标签（被退役了）要从条件里摘掉 —— 否则会出现
    // "条件里明明选着它、可筛选条上根本看不见它"这种看不出来的状态。
    // 这正是指令里那句"你已经删除过的旧标签不会出现在筛选条上，**也就筛不到它**"。
    const alive = new Set(list.map((t) => t.id));
    if (tagIds.value.some((id) => !alive.has(id))) {
      tagIds.value = tagIds.value.filter((id) => alive.has(id));
    }
    tagError.value = "";
  } catch (e) {
    tagError.value = toAppError(e).message;
  }
}

/**
 * 标签令牌一动（＝别处改了标签）就重读标签表，**并重查一次结果** ——
 * 结果行上的标签名与篇数都来自后端，不重查就会显示旧名字。
 *
 * `immediate: true`：挂载时正好靠它完成"读标签表 + 查一次"，一进来就有一屏内容。
 */
watch(
  () => props.tagToken,
  async () => {
    await loadTags();
    await run();
  },
  { immediate: true }
);

function startRename(t: TagStat) {
  editingId.value = t.id;
  editName.value = t.name;
  tagError.value = "";
}

function cancelRename() {
  editingId.value = null;
  editName.value = "";
}

/**
 * 提交改名。名字被别的标签占着时后端返回 validation 错误 —— 这里原样显示，
 * **什么都不改**（不合并、不改任何一个标签）。
 */
async function commitRename() {
  const id = editingId.value;
  if (id === null || tagBusy.value) return;
  const name = editName.value.trim();
  if (!name) {
    cancelRename();
    return;
  }
  tagBusy.value = true;
  try {
    const finalName = await renameTag(id, name);
    cancelRename();
    emit("notice", `已改名为「${finalName}」`);
    await loadTags();
    await run();
    emit("tags-changed");
  } catch (e) {
    // 故意**不关掉输入框**：撞上重名时应该能就地改个名字重试，而不是从头再来。
    tagError.value = toAppError(e).message;
  } finally {
    tagBusy.value = false;
  }
}

/**
 * 让标签"退休"（界面上的「删除」）。
 *
 * 不做二次确认：它连日记的边都碰不到，而且重新打一次同名标签就复活了。
 * 提示里必须说清两件事：① 从此不再出现在列表里；② **已经贴过它的日记仍然保留它**
 * —— 后者是用户最担心的"我的日记呢"。
 */
async function removeTag(t: TagStat) {
  if (tagBusy.value) return;
  tagBusy.value = true;
  try {
    const affected = await retireTag(t.id);
    emit(
      "notice",
      affected > 0
        ? `已移除标签「${t.name}」——以后不再出现在这里；另有 ${affected} 篇日记仍保留它`
        : `已移除标签「${t.name}」（本来就没有日记在用它）`
    );
    if (editingId.value === t.id) cancelRename();
    await loadTags();
    await run();
    emit("tags-changed");
  } catch (e) {
    tagError.value = toAppError(e).message;
  } finally {
    tagBusy.value = false;
  }
}

/** 「自定」选中的那两天是不是反着的（只是给用户一句提示，不作为错误）。 */
const customReversed = computed(
  () =>
    !!customFrom.value &&
    !!customTo.value &&
    customFrom.value > customTo.value
);

/** 时间按钮上要显示的"今天"（只读一次，够这一屏用）。 */
const todayText = toDateKey(new Date());
</script>

<template>
  <div class="filter">
    <!--
      条件区：**一行一个维度**。最左边是维度名，右边全是小药丸。
      每行**都没有**"全部"按钮 —— 点已经选中的那颗就是取消它。
    -->
    <div class="cond">
      <div class="row">
        <span class="label">排序</span>
        <div class="main">
          <button
            type="button"
            class="pill"
            :class="{ on: recentFirst }"
            @click="recentFirst = true"
          >
            最近优先
          </button>
          <button
            type="button"
            class="pill"
            :class="{ on: !recentFirst }"
            @click="recentFirst = false"
          >
            最早优先
          </button>
        </div>
      </div>

      <div class="row">
        <span class="label">标签</span>
        <div class="main">
          <div ref="pillsRef" class="pills" :class="{ clamped: !tagsExpanded }">
            <span v-if="tags.length === 0" class="none">还没有标签</span>
            <button
              v-for="t in tags"
              :key="t.id"
              type="button"
              class="pill"
              :class="{ on: tagIds.includes(t.id) }"
              :title="`${t.name}（${t.entry_count} 篇）`"
              @click="toggleTag(t.id)"
            >
              {{ t.name }}
            </button>
          </div>
          <button
            v-if="tagsNeedMore || tagsExpanded"
            type="button"
            class="more"
            @click="toggleTags"
          >
            {{ tagsExpanded ? "收起 ∨" : "更多 ∨" }}
          </button>
        </div>
      </div>

      <div class="row">
        <span class="label">心情</span>
        <div class="main">
          <button
            v-for="m in MOODS"
            :key="m.value"
            type="button"
            class="pill mood"
            :class="{ on: moods.includes(m.value) }"
            :title="m.label"
            @click="toggleMood(m.value)"
          >
            {{ m.emoji }}
          </button>
        </div>
      </div>

      <div class="row">
        <span class="label">时间</span>
        <div class="main">
          <button
            type="button"
            class="pill"
            :class="{ on: range === 'all' }"
            @click="range = 'all'"
          >
            不限
          </button>
          <button
            type="button"
            class="pill"
            :class="{ on: range === '7d' }"
            @click="range = '7d'"
          >
            近 7 天
          </button>
          <button
            type="button"
            class="pill"
            :class="{ on: range === '30d' }"
            @click="range = '30d'"
          >
            近 30 天
          </button>
          <button
            type="button"
            class="pill"
            :class="{ on: range === 'year' }"
            @click="range = 'year'"
          >
            今年
          </button>
          <button
            type="button"
            class="pill"
            :class="{ on: range === 'custom' }"
            @click="range = 'custom'"
          >
            自定
          </button>

          <!--
            ⚠️ 日期框**不要自己给它写颜色**：`global.css` 里已经设了 `color-scheme`，
               原生的日期框在深浅两套主题下都会跟着变色。
          -->
          <template v-if="range === 'custom'">
            <input v-model="customFrom" class="date-input" type="date" :max="todayText" />
            <span class="tilde">至</span>
            <input v-model="customTo" class="date-input" type="date" :max="todayText" />
          </template>

          <span v-if="customReversed" class="hint">起止反了，这样查不到东西</span>

          <button type="button" class="clear" @click="clearAll">清空条件</button>
        </div>
      </div>
    </div>

    <!-- 结果 -->
    <div class="results">
      <p v-if="errorText" class="error">{{ errorText }}</p>
      <!-- 第一次还没拿到结果时说一句；之后再查**不清空旧结果**，免得每次点一下都闪一下。 -->
      <p v-else-if="!result" class="note">{{ loading ? "正在读取…" : " " }}</p>
      <template v-else>
        <p v-if="result.total === 0" class="note">{{ emptyMessage }}</p>
        <p v-else-if="truncated" class="note">
          只显示前 {{ result.limit }} 条（按当前排序）。想找更早的，用上面的时间条件缩小范围。
        </p>

        <ul class="list">
          <li v-for="h in result.hits" :key="h.entry_date">
            <button type="button" class="item" @click="emit('open', h.entry_date)">
              <div class="head">
                <span class="date">{{ humanDate(h.entry_date) }}</span>
                <!-- 没标心情就**什么都不显示**（不占位、不写"无"）。 -->
                <span v-if="h.mood" class="mood" :title="`心情 ${h.mood}`">
                  {{ MOODS.find((m) => m.value === h.mood)?.emoji ?? "" }}
                </span>
                <!-- 没有标签也**什么都不显示**（这条能出现说明它是按时间或心情筛出来的）。 -->
                <span v-if="h.tags.length" class="chips">
                  <span v-for="t in h.tags.slice(0, TAGS_PER_ROW)" :key="t" class="chip">
                    {{ t }}
                  </span>
                  <span
                    v-if="extraTags(h) > 0"
                    class="chip more"
                    :title="h.tags.join('、')"
                  >
                    +{{ extraTags(h) }}
                  </span>
                </span>
              </div>
              <!-- 第二行是**后端拼好的一句话**（纯图片日记会是「〔这一篇有 N 张图片〕」）。 -->
              <p v-if="h.line" class="line">{{ h.line }}</p>
            </button>
          </li>
        </ul>
      </template>
    </div>

    <!--
      标签管理：**默认收起**（它是"管理"，不是"筛选"），钉在页面最下面。
      点筛选条上的标签 ≠ 改标签 —— 改名 / 退役只在这里做（两件事混在一起会误删标签）。
    -->
    <div class="manage">
      <button type="button" class="manage-head" @click="manageOpen = !manageOpen">
        <span class="caret">{{ manageOpen ? "▾" : "▸" }}</span>
        标签管理
        <span class="manage-total">{{ tags.length }}</span>
      </button>

      <div v-if="manageOpen" class="manage-body">
        <p v-if="tagError" class="error">{{ tagError }}</p>
        <p v-if="tags.length === 0" class="none">还没有标签</p>
        <ul class="manage-list">
          <li v-for="t in tags" :key="t.id" class="tag-item">
            <template v-if="editingId === t.id">
              <input
                v-model="editName"
                class="tag-edit"
                type="text"
                :maxlength="TAG_MAX_CHARS"
                :disabled="tagBusy"
                @keydown.enter.prevent="commitRename"
                @keydown.esc="cancelRename"
              />
              <button type="button" class="tag-op" title="保存" @click="commitRename">
                ✓
              </button>
              <button type="button" class="tag-op" title="取消" @click="cancelRename">
                ✕
              </button>
            </template>
            <template v-else>
              <span class="tag-name" :title="t.name">{{ t.name }}</span>
              <span class="tag-count">{{ t.entry_count }} 篇</span>
              <button
                type="button"
                class="tag-op"
                title="改名（改名不会合并到同名标签上，重名会报错）"
                @click="startRename(t)"
              >
                ✎
              </button>
              <button
                type="button"
                class="tag-op danger"
                title="移除标签（以后不再出现在列表里；已写过的日记仍保留它）"
                @click="removeTag(t)"
              >
                ✕
              </button>
            </template>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.filter {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

/* ── 条件区：一行一个维度 ─────────────────────────────────────────────── */
.cond {
  flex-shrink: 0;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 5px 0;
}
.label {
  flex-shrink: 0;
  width: 32px;
  padding-top: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.main {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

/*
  一颗药丸。
  ⚠️ `line-height` 是**写死的** —— 下面 `.pills.clamped` 的两行高度靠它算准。
     改 padding / font-size / line-height / border 时，那个高度要一起改，
     否则折叠时会切出半行。
*/
.pill {
  flex-shrink: 0;
  padding: 3px 10px;
  font-size: 12px;
  line-height: 16px;
  color: var(--text-2);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
}
.pill:hover {
  background: var(--hover);
  color: var(--text-1);
}
/* 选中态：**只用主题变量**，⛔ 一个色号都不许写死（B站 的红色不许照抄）。 */
.pill.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--text-1);
}
.pill.mood {
  padding: 3px 8px;
  font-size: 13px;
}
.none {
  font-size: 12px;
  color: var(--text-3);
}

/*
  标签行：折起来时只露**两行**。
  一行药丸 = 16(line-height) + 3×2(padding) + 1×2(border) = 24px；
  两行 + 中间那道 6px 的缝 = 54px。⚠️ 改 `.pill` 的尺寸，这里的 54 要跟着改。
*/
.pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.pills.clamped {
  max-height: 54px;
  overflow: hidden;
}
.more {
  flex-shrink: 0;
  padding: 3px 10px;
  font-size: 12px;
  line-height: 16px;
  color: var(--text-3);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}
.more:hover {
  background: var(--hover);
  color: var(--text-2);
}
.date-input {
  padding: 2px 6px;
  font-size: 12px;
  color: var(--text-1);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.tilde {
  font-size: 12px;
  color: var(--text-3);
  padding-top: 4px;
}
.hint {
  font-size: 12px;
  color: var(--text-3);
  padding-top: 4px;
}
.clear {
  margin-left: auto;
  flex-shrink: 0;
  padding: 3px 10px;
  font-size: 12px;
  line-height: 16px;
  color: var(--text-2);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}
.clear:hover {
  border-color: var(--accent);
  color: var(--text-1);
}

/* ── 结果列表 ─────────────────────────────────────────────────────────── */
.results {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding-top: 12px;
  overflow-y: auto;
}
.note,
.error {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--text-3);
}
.error {
  color: var(--danger);
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  margin-bottom: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
}
.item:hover {
  border-color: var(--accent);
}
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}
.date {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
}
.mood {
  flex-shrink: 0;
  font-size: 13px;
  line-height: 1;
}
/* 标签靠右：第一行是"左日期 · 中/右标签"，与检查过的样例图一致。 */
.chips {
  margin-left: auto;
  display: flex;
  flex-shrink: 1;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}
.chip {
  flex-shrink: 0;
  padding: 1px 6px;
  font-size: 10px;
  line-height: 15px;
  color: var(--text-2);
  background: var(--hover);
  border-radius: 4px;
}
.chip.more {
  color: var(--text-3);
}
.line {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-2);
  word-break: break-word;
}

/* ── 标签管理（默认收起，钉在最下面） ─────────────────────────────────── */
.manage {
  flex-shrink: 0;
  margin-top: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.manage-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 4px 0;
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  color: var(--text-2);
  background: transparent;
  border: none;
  cursor: pointer;
}
.manage-head:hover {
  color: var(--text-1);
}
.caret {
  font-size: 10px;
}
.manage-total {
  font-weight: 400;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.manage-body {
  max-height: 34vh;
  overflow-y: auto;
  padding-top: 6px;
}
.manage-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.tag-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 2px 3px 6px;
  border-radius: 6px;
}
.tag-item:hover {
  background: var(--hover);
}
.tag-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-count {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
/* 改名 / 退役：常显但压暗，悬停才提亮 —— 一直闪会吵，完全藏起来又没人知道有按钮。 */
.tag-op {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  padding: 0;
  font-size: 12px;
  line-height: 1;
  color: var(--text-3);
  opacity: 0.5;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
.tag-item:hover .tag-op {
  opacity: 1;
}
.tag-op:hover {
  color: var(--text-1);
  background: var(--hover);
}
.tag-op.danger:hover {
  color: var(--danger);
}
.tag-edit {
  flex: 1;
  min-width: 0;
  padding: 2px 6px;
  font-size: 12px;
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--accent);
  border-radius: 5px;
  outline: none;
}

/* ⚠️ 顶栏那行数字在窄窗口会挤，但那是 App.vue 的事（本组件不碰顶栏）。 */
</style>
