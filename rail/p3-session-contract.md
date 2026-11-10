# P3-0 会话、命令与平台绑定合同 v1

状态：可执行原型；通过 Cargo feature `session-contract` 启用。当前网页继续使用 MAP65。原型加载冷世界并复用既有资产/编辑规则，实时乘客、初始化、城市和存档接管按 P3-1～P3-8 推进。

## 唯一所有者

Rust `SessionHost` 保存 sessionId、revision、世界、配置与有界命令回执。调用者拿到的是脱离内部状态的查询值。Rust 原生调用 `SessionHost::request(&[f64])` 和 WASM `session_contract()` 使用同一有序值协议；没有 JS 业务实现。

本轮 open 接受已生成的 MAP65 冷世界和配置。配置来自固定测试夹具，是待移除的过渡输入；P3-1 再迁移 Rust 新游戏与配置初始化。本轮明确拒绝携带活动 runtime 的 open，避免产生“世界已更新、运行队列仍旧”的假事务。

## 请求与结果

所有请求携带数值 `protocolVersion: 1`。除 open 外须携带当前 sessionId；命令编号为递增正安全整数，revision 为非负安全整数。

| op | 必需字段 | 原型行为 |
| --- | --- | --- |
| open | world、config | 完整校验后替换冷会话，分配新的 sessionId，revision=0；失败保留旧会话 |
| query | sessionId、view | snapshot 返回完整世界；status 返回命令高水位与回执上限；receipt 按 commandId 查已处理结果 |
| preview | sessionId、expectedRevision、command | 调用现有原生规则预览报价，保持实际世界和revision不变 |
| dispatch | sessionId、commandId、expectedRevision、command | 原生候选事务、成功后一次提交；revision加1并产生WorldCommitted事件 |
| close | sessionId | 释放当前会话；旧sessionId随后失效 |

原型命令只开放 `{kind:'fleet', op:'purchase', args:{spec,count}}` 和 `{kind:'network', op:'renameStation', args:{id,name}}`。其余命令返回 COMMAND_NOT_SUPPORTED_YET；后续阶段按事务完整性扩展，避免先开放编辑而漏迁移活动运行。

统一结果：protocolVersion、ok、sessionId、revision、result、events；失败附error.code，规则拒绝可附details。中文展示由UI依据错误码呈现。receipt或重复请求可带replayed及currentRevision；返回的revision仍是原命令的批准修订。

## 原子性与重复命令

- 预览不提交候选。提交前复用现有资产/编辑规则，并验证候选世界与财务；失败保持世界及revision不变。
- 查找历史回执先于校验expectedRevision。相同commandId和完全相同有序请求重试，重放原结果而不再次扣款。
- 已使用编号携带不同请求返回COMMAND_ID_REUSED；旧编号的回执被淘汰后返回COMMAND_EXPIRED，仍不重复执行。
- 保留最近128条成功或拒绝回执。首次处理的有效编号推进高水位；修订冲突和规则拒绝也保留结果，修改后重试使用新编号。
- dispatch/preview有4096个wire数值的请求上限，防止有界条数的回执保存任意大的命令。超大命令、无效编号、错误会话不进入提交。
- 新会话编号递增，重开/关闭后迟到命令不能作用到新会话。回执在本轮是进程内状态，跨崩溃的提交日志由P3-7定义。
- 输入wire先检查类型标签、长度、字符串索引/UTF-16、深度和总长度，错误返回INVALID_WIRE，不替换会话。

已有完整乘客/现金/库存/历史守恒继续由MAP65回归保护；本轮尚未将运行队列装入新session，不能据此宣称完整游戏事务已接管。

## 后续接口预留

advance/pulse、订阅增量ViewModel、导入预览token/确认、保存/导出以及异步预测结果接纳在对应阶段实现。它们统一使用会话身份、命令号和修订，UI不直接修改Rust状态。保存快照必须来自同一批准revision，预测结果必须携带输入修订，过期结果由Rust拒绝。

## 平台绑定决策

本阶段选择已有的无第三方运行依赖、显式有序值ABI，沿用Rust 1.99.1与wasm32-unknown-unknown固定构建。新增导出为session_abi/session_contract；原型二进制仅放在scripts/fixtures，不改页面、生产Worker或生产WASM。

不在本轮引入wasm-bindgen/web-sys及其生成工具链；后续Rust平台层可在同一合同下采用固定生成绑定，或最小显式导入。两者都只允许API/字节/事件转发，游戏默认值、排队、重试、修订接纳和失败恢复策略归Rust。原型已经验证Rust持有会话和Worker可转移缓冲；浏览器File/Storage/IndexedDB探针验证平台能力和字节往返，不代表P3-7持久化策略已迁入Rust。

手写JS最终允许：界面；确有平台需要的绑定只可转发，必须登记。Math数学原语当前沿用现有宿主导入，以保持浮点结果；RNG权威与数学导入清理列入后续阶段。本轮原型命令不消耗命名随机数。

## 可复现验证

```sh
node scripts/audit_rail_p3.cjs
node scripts/test_rail_p3_boundary.cjs
node scripts/test_rail_p3_contract.cjs
node scripts/build_rail_wasm.cjs --check
node scripts/build_rail_session_contract.cjs --check
node scripts/run_rail_tests.cjs
```

真实浏览器：开发主机提供Playwright 1.62.1及Chromium后运行 `node scripts/probe_rail_p3_browser.cjs /tmp/rail-p3-browser-results.json`；可通过RAIL_CHROMIUM指定现有浏览器。CI安装固定Playwright后执行同一入口。覆盖主线程/Worker的真实WASM、可转移缓冲、重复命令、完整状态、浏览器文件和数据库往返，以及两地图开始/暂停操作。所有测试夹具均在scripts，不随游戏发布。
