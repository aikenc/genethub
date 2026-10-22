# datas：团队要长期维护的东西

这里放团队名下**希望持久维护**的一切：项目仓库、资料、调研产出、数据，不限于仓库。团队的文件都放在团队自己的目录里，不散落到机器的别处。

- **命名建议**：`datas/<group>/<project>` 或 `datas/<group>/<folder>`。仓库用地址里的 group 和名字（`https://github.com/aikenc/genethub` → `datas/aikenc/genethub`）；别的东西自己起个 group 归类，如 `datas/research/competitors`。命名是建议，不是强制，但要让人一眼看出是什么。
- **谁写**：工作会话写；思考会话与前台只读。思考想验证就去 `temp/` 做副本；要改就交给工作会话。
- **取路径**：不要自己拼相对路径。运行 `tools/team.py path datas <group>/<name>`（或 `--from <git 地址>`）得到绝对路径，加 `--create` 同时建目录。
- **看内容**：`tools/team.py datas ls`。
- **一个目录同一时间只有一个写会话**：开工作会话时用 `spawn --dir <绝对路径>`。
- **不要放这里的**：几天内会不用的临时文件，放 `temp/`。
- 用 `tools/team.py mount <路径>` 认领的外部项目目录不受这里的约束，原来在哪还在哪。

这个文件由产品维护，每次 GeneHub 启动时会被覆盖；不要在这里记笔记。
