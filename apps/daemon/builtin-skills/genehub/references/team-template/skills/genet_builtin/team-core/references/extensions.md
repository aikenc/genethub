# 项目扩展合同（Team API 1 / Framework 1）

## 目录和选择

```text
agent-space.genet.json           # 同一描述文件，不增加配置文件
tools/run.py                    # 统一入口：命令、tick、describe、board serve
tools/genet_builtin/            # 平台随附 Python 包，尽量不改
tools/<业务包>/                 # 项目 Class 和依赖，名称由项目选择
skills/genet_builtin/team-*/     # 平台随附 Skill
skills/<业务分组>/<技能>/        # 项目 Skill，可设多个 folder Provider
```

`genet_builtin` 是维护约定，不是权限边界。必要时可以修改内置文件，但须记录原因、摘要和升级补丁。项目不要复制整个调度器，也不要把业务类放进平台包。

在根 `agent-space.genet.json` 的 `team` 对象指定 `module:Class`：

```json
{
  "team": {
    "apiVersion": 1,
    "frameworkVersion": "1",
    "resource_class": "studio.resources:ProjectResources",
    "board_class": "studio.board:ProjectBoard",
    "settings": {"resource": {"pool": "worktrees"}}
  }
}
```

对应代码放 `tools/studio/`（带 `__init__.py`）。可选 `class: "studio.mode:StudioMode"` 指定 TeamMode；没有多个槽位默认值需要绑定时直接配槽即可。优先级：内置默认 → TeamMode 的类属性 → team 中显式槽位；settings 按 workflow/resource/reflection/board/commands 分组传入。`tools/run.py describe` 给出实际类、来源、binding 版本和源摘要，不存在或不兼容的类明确报错，不静默回退。

公开导入统一来自 `genet_builtin.api`：

| 基类 | 重写点 | 调用边界 |
|---|---|---|
| TeamMode | workflow_class/resource_class/reflection_class/board_class/commands_class | 只提供默认 Class，构造不得执行任务 |
| WorkflowPolicy | check_request(context, request)、check_completion(context, task) | 创建或支持派单前、成功结算前；返回 Decision |
| ResourcePolicy | plan_resource(context, request)、prepare_resource(context, binding)、check_release(context, binding) | 规划、平台取得唯一写锁后准备、原生空闲及进程检查后释放；返回 ResourcePlan/None、JSON对象、Decision |
| ReflectionPolicy | evaluate(context, snapshot) | timer 经平台重复/间隔保护后评估；allow 必须有原因 |
| BoardPresenter | sections(context, snapshot) | 真实会话数据采集完成后；返回 [{title,text}]，展示自动转义 |
| TeamCommands | register(subparsers, services) | 注册业务命令，返回 command→handler；不得注册时执行业务或覆盖核心命令 |

`check_completion` 的公开快照字段固定为 taskId/sessionId/outcome/evidence/parameters/supports；supports 提供会话及结论，内部 control/dispatch 结构不作为业务 API。

公共值类型：TaskContext、TaskRequest、ResourcePlan、ResourceBinding、Decision（allow/hold/unknown；后两者必须有原因）、ReleaseDecision（Decision 同义名）。JSON业务参数和准备回执上限128 KiB，不放秘密或巨型产物。构造函数 `(context, settings)` 不执行 I/O；不需要为岗位、Space 或每个 py 建一个类。

## 资源与工作流

```python
from pathlib import Path
from genet_builtin.api import ResourcePolicy, ResourcePlan, Decision

class ProjectResources(ResourcePolicy):
    def plan_resource(self, context, request):
        slot = request.parameters.get("slot")
        if not slot:
            raise ValueError("需要明确项目槽")
        # 业务应在这里验证槽是否属于自己的池；目录必须已存在。
        return ResourcePlan(str(Path(context.team_root) / self.settings["pool"] / slot))

    def prepare_resource(self, context, binding):
        # 幂等键=context.operation_id。准备分支、双仓环境等业务资源；
        # 重试必须查询同一操作，未知保留，不能重做已完成副作用。
        return {"slot": binding.directory}

    def check_release(self, context, binding):
        # 在这里核对双仓干净、实例结束、QA回执等；未知返回 unknown。
        return Decision.hold("业务验收未完成")
```

返回 ResourcePlan 后平台保存规划、认领实际目录上的唯一锁，再保存准备回执，最后 prepare/activate 原生会话。准备异常保留原操作和锁。项目不用另建租约；已有 project.py 的整槽预占应迁入此流程，不能先占一个锁再由 task 抢第二个。平台保护幂等创建、归属与反向依赖先持久化、暂停及共享预算、真实会话/队列/进程和精确锁持有者检查；重写业务方法不能越过这些保护。

结果回传与资源可复用独立：hold/unknown 写回原 task-dispatch 的 resourceRelease，结果仍能结算。timer 后续检查原 resourceBinding，即使 pending 已进入 done、收件箱已消费也不会忘记；不建立第二套任务状态。已交接则资源绑定跟随新Owner。未激活的未知准备不自动释放。

业务命令使用注入的 TaskService：start/support/status/send/finish/control，所有调用仍走同一任务账本和资源规则。例如 `services.start(request_id=..., role="leader", goal=..., parameters={"slot":"dev-1"})`。普通 `task start/support --parameters '{...}'` 同样生效；不能通过旧 spawn 绕过自定义工作流或资源策略。遗留无 Class 绑定任务先用原制品收尾，再采用新自定义策略。

自定义资源策略暂要求在已安装完整团队代码的执行端运行；不能在源端把远端路径当本机规划。普通默认资源的跨机岗位派单继续原协议。跨机产品任务由已部署的执行团队入口调用其配置策略，回执精确交回请求会话，不得假装资源钩子已跨机执行。

## Skill、生效和升级

项目 Skill 自己配置 folder Provider：例如 `{ "type":"folder", "path":"skills/studio" }`，并在相关岗位 skills[] 选中它。通用 Skill 保持按名引用，不复制改写整份 team-core；身份文件只描述项目差异，避免重复定义调度规则。

源端 `spacebuilder.py build <定义源> --output <独立制品>` 自动携带 team 配置、tools 下非隐藏 Python/JSON/JS依赖、编译后的身份与 Skill/hook。不携带外部 pip 包、绝对本机依赖或业务数据；依赖应随 tools 包提供或由安装器显式满足。目标端无需源仓：`spacebuilder.py verify <制品> --artifacts-only`，再用制品 `tools/run.py describe` 和实际任务验收。执行副本不反向修改定义源。

兼容平台升级只替换 genet_builtin 包/Skill和薄入口，保留业务源码、配置、身份及数据。首次升级提取旧版内部修改成本可高；后续依赖稳定公开方法而不是拷贝内部代码。破坏公开签名、语义、持久绑定或准备/释放含义时必须升 API/binding 版本并给迁移说明；不能保证任意 monkey patch 都自动兼容。采用新的 Class/settings 前必须结算或显式迁移在途任务。部署时验证完整制品及后台进程采用；回退保留能读新账本的收尾路径。

远端运行副本由定义源 `run.py employee sync` 按岗位的 `TEAM_MACHINE` 安装完整产物，参见 [远端岗位](remote-targets.md)。目标机只改本机配置与业务数据，身份／Skill／策略类回定义源维护；在途任务保留原制品收尾。新任务使用 task，脚本自动使用 members 和原返回回执。
