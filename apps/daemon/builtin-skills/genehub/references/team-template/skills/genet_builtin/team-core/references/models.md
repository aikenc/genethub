# 模型：后台会话用什么、怎么查

- **默认按目标岗位配置**：普通 `task start` / `task support` 与 `spawn` 在本机先读团队默认，再用已登记目标岗位的 `.genethub/open.env` 覆盖 `TEAM_AGENT`；反思岗位使用 `TEAM_MODEL_REFLECT`，研究岗位使用 `TEAM_MODEL_RESEARCH`，其余岗位使用 `TEAM_MODEL_WORK`。目标岗位未配置时沿用团队默认，再回退请求方的 Agent/模型与思考强度。显式 `--model` / `--tier` 优先，用户没提档位就别加 `--tier`。远程由执行端自己的配置选择，不把源机模型带过去；重放原派单仍用已保存选择，不因配置更新改变原会话。
- **点名模型不等于指定档位**：用户说“只用 DeepSeek Flash”时，先核对实际模型 ID 和成本，沿用符合要求的本机覆盖或显式 `--model <id>`；不要因名称里有 Flash 就加 `--tier Flash`。同名档位可能路由到其他供应商；Pro 档位也可能配置为极低成本模型。用户指定的思考强度单独核对，不因模型便宜就假定强度已正确。
- **用户指定了档位或领域偏好**（比如"评审方向的思考用 Max"）：照做，`spawn --tier Max`；偏好是长期的，记进 `memory.md`，以后同类会话照它选。档位支持 `Ultra`、`Max`、`Pro`、`Flash`、`Mini` 五档；具体用哪个模型由本机配置当场决定，你不用选 id。
- **任务里有图片或视频**：加 `--media image` 或 `--media video`。你的模型看不了时脚本会换成同档位、成本最接近的能看的模型；没有就报错，把原因告诉用户，不要硬做。路径写进任务文字，图片本身传不过去。
- **被问"用的什么模型、成本高不高"**：自己用 `"$GENEHUB_CLI" session get "$GENEHUB_SESSION_ID"`（看 `summary.modelId`）；别的会话用它的 id；本机有哪些选择、各是什么档位和成本档用 `"$GENEHUB_CLI" agent list --routes [--tag Pro] [--media image]`。如实回答：成本只有「极低…极高」五档和 token 数，**没有金额**，不要估算金额。
- 要给已有的长期会话换档（用户改了偏好）：`"$GENEHUB_CLI" session model <会话> --tag Pro`；点名模型用 `--model <id>`，只对没有按档位路由的会话有效。点名的模型属于另一个 Agent 时（比如 Hy4 只有 codebuddy 有，会话却开在 codex 上）会话会自动迁过去，不用先建新会话。
- 路由的档位和成本档是用户在设置里配的，你只读，不要想办法改。
