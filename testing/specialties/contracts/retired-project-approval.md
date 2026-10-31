# Removed platform approval recovery probe

The wrapper `specialty.contracts.project-approval-recovery` was retired on 2026-10-30. Upstream commit `01b545a6b4080ab6c0f040687d59df29adfc0013` removed the platform PM approval layer, including `project_control` and the two exact Rust test symbols this wrapper invoked. Full dev run `261030-1315-network-v2-final-dev-ready-b143` proved the stale filter ran zero tests; it was recorded as failed, never passed.

The product contract gives authenticated full Agent connections the target OS user's authority. We do not recreate approval challenges to satisfy a removed mechanism's oracle. Human choices in native Agent tools and managed Skill workflows remain separate concerns.

Existing public coverage remains active: `specialty.authorization.agent-session-control-parity`, `specialty.agent-space.durable-native-plan`, `specialty.recovery.workflow-retired`, credential revocation/expiry and display-only share cases. Their real effects and refusal boundaries remain required. This change removes an obsolete wrapper, adds no waiver or suspension, and does not change release policy or the two pre-existing suspended legacy rows.

During the dev-3 integration, the independently ported native expired-plan property is retained as `specialty.contracts.native-plan-recovery`. It invokes the existing native Agent card refresh property and verifies timeline state; it does not restore platform PM approvals or the removed exact test symbols. The old case name remains retired.
