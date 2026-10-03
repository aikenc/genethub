# 跨机文件传输

用于用户明确要求在 GeneHub 已授权的机器之间传文件，包括 GB 级文件和断点续传。动手前先记下：源机器、
源文件的绝对路径、目标机器、目标路径。两边的路径各按所属机器解析。

## 模型：接收方下载

只有一种能力：**接收文件的机器从源机器下载**。

- 从 B 取文件到本机 A：在 A 上执行 `file download --from B …`。
- 把本机 A 的文件给 B：用 remote shell 让 B 执行同样的下载：
  `"$GENEHUB_CLI" --machine B shell -- genet file download --from A …`。前提是 B 能连到 A
  （在 B 上执行 `machine list --reachable` 能看到 A）。

续传、完整性校验和最终落盘都在接收方完成，判断是否完成也以接收方为准。remote shell 只负责启动和查询
传输任务，文件内容走专用的数据流，不经过 shell 的输出。

## 命令

```bash
"$GENEHUB_CLI" file download --from <源机器ID> <源绝对路径> <目标路径> [--overwrite] [--no-wait] [--timeout <秒>]
"$GENEHUB_CLI" file transfer status [<transferId>]
"$GENEHUB_CLI" file transfer cancel <transferId>
```

- `--from` 必须用 `machine list --reachable` 返回的机器 ID。源路径可以是源机器上的任意绝对路径。
  如果调用方是只获准访问工作区文件的配对设备，工作区以外的路径会被拒绝（需要 `pty:unconfined`）；
  用户本人和 Hub 通道没有这个限制。
- `file` 只能在本机执行，`--machine` 对它无效。要让文件落到别的机器，就在那台机器上执行（见上文）。
- 目标路径可以是相对路径，按调用方当前目录解析。目标所在目录必须已存在。目标文件已存在时会被拒绝
  （`destinationExists`），只有用户明确要求覆盖时才加 `--overwrite`。
- 默认会等待传输结束：先输出 `transfer.started`，等待期间每 10 秒输出一次 `transfer.progress`，最后输出
  `transfer.result` 或错误。`--no-wait` 和 `--timeout` 只是不再等待，传输仍在 daemon 里继续；之后用
  `file transfer status <id>` 查询。从 remote shell 发起时建议加 `--no-wait`，再查询状态，这样不会被
  shell 的超时卡住。

## 完成、续传与失败

- **完成**：状态为 `completed`，并带有 `sha256`。这表示接收方计算出的 SHA-256 与源文件一致，部分文件也已
  重命名到目标路径。只看到 `transfer.started`、进度到 100%、命令退出码为 0 或者有临时文件，都不能算完成。
- **断线**：传输任务会自动按已落盘的偏移重连续传。连续失败 6 次后转为 `interrupted`。
- **`interrupted`**（例如 daemon 重启）：用完全相同的 `--from`、源路径和目标路径再执行一次
  `file download`，会从部分文件处续传，`resumedFrom` 显示续传起点。不要先删部分文件，也不要改成别的
  目标路径再重试。
- **`sourceChanged`**：传输期间源文件发生了变化（大小或修改时间不同）。部分文件会被丢弃，需要重新开始。
  先告诉用户源文件变了，不要自动重下。
- **`integrityMismatch`**：校验不一致，部分文件会被丢弃。如实报告，不要把它说成已完成。
- 部分文件位于目标目录下，名为 `.<文件名>.genet-partial-<transferId>`。完成或取消后会被清理，中断时保留，
  供续传使用。

## 不要做的事

- 不要用打印文件内容、Base64 或 `shell` 的输入/输出来传文件：`shell` 的输入上限是 1 MiB，输出按文本处理，
  二进制内容会被改坏。
- 不要为了传文件去扩大配对或授权范围。传不了时报告具体缺口，例如机器不可达、缺少某项授权或目标目录
  不存在。
- 报告网络实测结果时，注明文件大小、方向和实际走的通道。小文件能传通，不代表几 GB 的文件或长时间
  传输已经验证过。
