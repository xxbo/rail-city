# P3-6：版本化兼容模型与剩余算法（源码阶段）

2026-11-10。承接 `codex/p3-5-source`，交付 `codex/p3-6-source`。本阶段仅修改源码、冻结参考源码和构建/发布配置；P3-2～P3-6均待统一编译与验收。

## 模块去向

| 原入口 | Rust实现 | 保留的区别 |
| --- | --- | --- |
| engine.js建设、直通、票价、班次、图、evaluate、step | legacy.rs | version-2季度经营、公司现金、90日收入系数、线路承运/轨道出租、两轮拥挤反馈、季度人口/岗位预算 |
| city.js旧assign、固定重力分布、journeys、evaluateLegacy | legacy_city.rs | 最近站严格800m阈值、1.25步行绕行、全城固定目的地分母、正/返向、原目的比例/衰减与供给限额 |
| operations.js旧演示运行 | legacy_operations.rs与独立Owner | version-1演示钟、加权目的地队列、0.1分钟步进、48km/h、0.6分钟停站、2分钟区间释放及2000条事件 |
| passengers.js与management.js旧legacyTick/小步重放 | RuntimeOwner、Seed、Calendar、Cycle、Queues | arrivalMode决定整数/加权；旧小数乘客保持加权，不套现代整数门控；有/无ridership统计独立配置 |
| 普通旧预测进入运行 | legacy_catalog.rs、ForecastOwner | 原生编译legs、名称和ID、票价/承运份额与抽样元数据；沿用同一目录/实际定义所有者 |
| 站点/列车乘客明细 | runtime_query.rs | 原生解析队列token和实际定义，返回目的地/用途汇总，界面不再解读journey身份 |
| 旧自动设施/开发初始化与候选筛选 | runtime_business.rs | 原生地形查询、原候选顺序/上限、自动设施、开发初始化；退出JS过滤和回调判定 |

季度公司账户、独立演示模型及连续运营的财务账户仍是各自的版本化模型。旧公司建设费不改写为现代人民币建设报价。运行会话增加kind=legacy的结构化命令，用于旧build/through/setFare/setHeadway/step；和迁移、撤销仍在同一Rust事务中提交。

## 生产入口与参考代码

engine.js、city.js、operations.js和passengers.js保留原API名称的调用适配；地图几何缓存、位置插值、DOM文案及Map解码属于显示/传输。M.change/M.preview现在接受结构化描述，宿主函数回调不再执行游戏编辑；内部低层逐步队列接口退出生产。

扫描生产引用后，旧simulation-wasm、preparation-wasm、engine-wasm、simulation-client、queue-runtime五个低层适配器已从HTML/需求Worker加载链移除。publish_rail.cjs按显式名单排除其Node参考别名，避免旧身份/包重放实现进入发布目录。

迁移前源码以rail-p3-6-*.cjs保存于scripts/fixtures，基线为远端P3-5提交 `bc846b56a28c4632dd8131b986984f4f57201781`。仅改写相对require和Worker文件路径，使参考模块指向同组冻结模块或现存公共依赖；未运行或重新生成行为预期。rail下的五个旧文件只保留Node测试别名，浏览器生产入口不加载它们。新旧公开低层合同的测试调用需在统一验证时按角色区分，不能用参考适配器的结果冒充原生会话验收。

## 收益与待验收项

收益重点是消除剩余JS旧模型算法和身份/小步驱动分支，让兼容规则在Rust内集中维护；暂不预设旧场景更快。旧季度模型与演示模型仍使用有序Value及冷投影，内部有复制和扫描成本。重力分区权重在Rust缓存，journeys按最多256条分页；运行中的预测/实际身份仍由原生目录管理。

需要后续统一构建并对照：季度两轮预测与出租收入、共享容量/独立复线/直通折扣、账本与人口/岗位增长、旧城市目的地分母/返向/步行边界、演示的信号和环线、加权/整数需求、无统计运行、跨版本恢复、旧票价改签、连续财务与暂停/撤销、普通预测目录导入、明细查询与大目录。

P3-6的“纯Rust驱动所有支持模型”完成条件仍待这些验证确认。自动JSON/文件导入导出、存储排序与恢复策略继续由P3-7接管；剩余平台绑定、只读ViewModel和任务超时/恢复在P3-8收口。

源码目标推进至rail-core-v31.wasm、会话合同fixture-v7、runtime_session_abi=4和缓存71。未编译、测试、浏览器检查、测量性能、生成WASM或AST清单，也未触发CI/发布。
