# 会话、命令与平台绑定合同（P3-1，协议v1）

状态：初始化接口已用于生产v26，session默认编译。历史v1原型字节仍冻结在测试目录，当前可复现产物为v2；协议号仍为1。实时乘客、编辑运行事务与持久化接管按P3-2～P3-8推进。

## 唯一所有者

Rust `SessionHost` 保存 sessionId、revision、世界、配置与有界命令回执。调用者拿到的是脱离内部状态的查询值。Rust 原生调用 `SessionHost::request(&[f64])` 和 WASM `session_contract()` 使用同一有序值协议；没有 JS 业务实现。

生产 `start` 只接收区域与可选存储读取结果，世界和配置由Rust构建；`open` 保留为冻结合同的低层兼容入口。本轮明确拒绝携带活动 runtime 的 open，避免产生“世界已更新、运行队列仍旧”的假事务。

## 请求与结果

所有请求携带数值 `protocolVersion: 1`。初始化start/prepare_start/commit_start/cancel_start以外，除open外须携带当前sessionId；命令编号为递增正安全整数，revision 为非负安全整数。

| op | 必需字段 | 原型行为 |
| --- | --- | --- |
| start | region、可选stored/legacy | Rust生成或接纳恢复状态后打开初始化会话 |
| prepare_start | region、可选启动参数 | 验证候选但保留旧会话，返回token |
| commit_start | token | 检查token及原会话修订后替换 |
| cancel_start | token | 丢弃候选，保留旧会话 |
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

本阶段选择已有的无第三方运行依赖、显式有序值ABI，沿用Rust 1.99.1与wasm32-unknown-unknown固定构建。生产新增bootstrap_abi/bootstrap_run/bootstrap_packed与session_abi/session_contract/session_packed。初始化使用独立实例，避免运行arena回收销毁原始缓存和会话；实例驻留开销单独计量。

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

## P3-1 大字符串传输

初始化与会话生产调用使用packed双通道：结构f64 + UTF-16LE字节字符串表；旧有序值协议保持用于冻结夹具。Rust检查偏移、长度、标签、80层深度、200万值节点、1200万结构数值及128MiB字符串字节限额，保留缺省、非有限数、负零、BOM和属性顺序。9MB扩展字段完整往返有专项验证。JSON编解码与数据库实际I/O目前仍由宿主转发，策略继续迁入P3-7。随机选择入口与消耗记录由Rust持有，底层熵原语仍为host Math.random，数学/熵导入最终收口在P3-8。


## P3-4运行事务扩展（源码，待统一验收）

初始化冷会话接口保持上述协议；活动运行使用 `op:runtime` 的独立arena句柄，详见 [P3-4记录](rust-wasm-p3-4.md)。此层ABI推进至2，协议包号仍为1。

| action | 输入 | 提交结果 |
| --- | --- | --- |
| command | id、commandId、expectedEditRevision、结构化command、undo | 候选编辑/付款/改签/迁移一次提交；result、quote、undoToken及批准视图 |
| preview | id、expectedEditRevision、command | 权威财务报价；实际运行状态保持原值 |
| demand | id、commandId、expectedEditRevision、catalog | 切换目录并迁移既有出行；迟到修订拒绝 |
| undo | id、commandId、expectedEditRevision、undoToken | 恢复一个原生检查点；游戏时刻变化后拒绝旧撤销 |

editRevision仅标识编辑/目录提交；模拟步进使用运行revision，持续pulse不使后台预测因时间前进而失效。成功命令保留128条有序请求回执；重试先查询回执，再检查修订。同号异参拒绝。回执重放携带当前批准视图，避免旧视图覆盖新状态；规则拒绝返回错误，下一请求可用新编号重试。

运行区的完整值物化只在Rust内部候选构造、重映射及撤销检查点使用，编辑事务返回运行摘要；既有存档快照接口仍开放供P3-7接管。Worker启动交接使用创建结果。对外手写JS桥接负责消息及显示投影。


## P3-5业务调度与只读投影（源码，待验收）

运行ABI为3。pulse/advance在Rust内部消化城市与观察到期边界，`syncBoundary`宿主写回入口退出默认路径。批次保留平台预算及财务暂停语义。

| action | 请求 | 响应 |
| --- | --- | --- |
| forecastInvalidate | id | 标记当前预测需要更新，供手动重算 |
| forecastBegin | id、blocked | Rust判断是否需要任务；返回ticket、expectedEditRevision与原生快照 |
| demand | 原P3-4字段及forecastTicket、forecastView | 校验编辑/城市/阶段凭据，接受目录及其展示元数据 |
| forecastFinish | id、ticket、success | 结束对应任务；失败保持dirty，旧ticket不清除新任务 |
| observe | id、eventId | 使用权威世界及实际运行数据创建观察，返回批准的观察投影 |
| diagnose | id、可选query=alerts | 同一arena中的诊断/报警与来源revision、editRevision、cityRevision、minute |
| forecastQuery | id、query=summary/connections、可选stations | 当前接纳目录与满意度上的查询投影及来源修订 |

城市和观察发布标记仅在对外含runtime的响应推进；内部审查/诊断读取不消耗标记。城市更新时返回worldPatch.urban与runtime.businessView.development，观察更新时返回worldPatch.operationsReview，避免普通pulse重复传送城市。预测脏状态随runtime.forecastStatus发布，JS计时器只唤醒任务请求。
