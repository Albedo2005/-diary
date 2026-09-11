# 源文件编码约定（因为这个坑已经踩过一次）

## 事故记录

在实现"打开某天 ≠ 写过某天"这个修复时，我用 **PowerShell 的文本替换**去改
源文件里的注释：

```powershell
$text = Get-Content $f -Raw
$new  = $text -replace '旧名', '新名'
Set-Content -Path $f -Value $new -NoNewline -Encoding UTF8
```

结果：Windows PowerShell 5.1 的 `Get-Content -Raw` **把 UTF-8 文件按 ANSI/GBK 解码**，
中文注释全部变成 mojibake（`锛`、`鈥`、`鐨`…），而且部分换行被吞掉，
把注释和代码粘到了同一行。

更糟的是**这个变换不可逆**：写回时的有损编码产生了 232 个替换字符，
信息已永久丢失。所幸代码本身是 ASCII，只有中文注释被毁，
而设计意图都记录在 `docs/` 里，所以可以重建。

## 规则

### 1. 所有源文件与文档使用 UTF-8（无 BOM）

`.editorconfig` 已声明。VS Code / JetBrains 会自动遵守。

### 2. 不要用 PowerShell 读写非 ASCII 的源文件

这是本次事故的**单一根因**。PowerShell 5.1 的默认编码行为在中文系统上是 ANSI/GBK，
且不同 cmdlet 的行为不一致（`Get-Content`、`Set-Content`、`>` 重定向各不相同）。

**需要改源文件时，用文件编辑工具，不要用 shell 文本处理。**

### 3. `.ps1` 脚本一律写成纯 ASCII

即使 `.editorconfig` 声明了 UTF-8，**无 BOM 的 `.ps1` 在 PowerShell 5.1 下仍会被
按 ANSI/GBK 解析**。所以项目里所有 `.ps1` 都不含非 ASCII 字符 —— 注释和输出
信息都用英文。这不是偏好，是必需。

### 4. 需要批量处理文本时用 Node 或 Rust

它们对编码的处理是明确且一致的。例如把非 UTF-8 文件转成 UTF-8：

```javascript
// Node：明确指定编码，不会有隐式 ANSI 回退
const text = fs.readFileSync(file, "utf8");
fs.writeFileSync(file, text, "utf8");   // 无 BOM
```

## 检查方法

确认一段时间后文件没有被动过：

```powershell
# 看头几行是否还是正常中文
Get-Content app\src-tauri\src\db.rs -TotalCount 1 -Encoding UTF8
# 期望输出：//! 数据层：加密数据库的连接管理、日记读写、双索引中文搜索、备份。
```

如果输出里出现 `锛`、`鈥`、`鐨`、`涓` 这类字符，就是又坏了。

## 为什么不加 git hooks 自动检查

项目当前**没有初始化 git**。如果将来初始化了，建议加一个 pre-commit
检查：扫描暂存文件是否包含 mojibake 特征字符。在此之前，靠上面的规则和
`.editorconfig` 约束。
