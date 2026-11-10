# P3-6冻结参考源码

来源：P3-5，远端提交bc846b56a28c4632dd8131b986984f4f57201781（本地对应树84e9cde1547a19def688ddcc3c4eff875b410c1d）。

rail-p3-6-*.cjs保留迁移前engine、city、operations、passengers、forecast-catalog及低层运行适配器。相对require及Worker文件路径已重定向至同组参考模块或../../rail中的既有依赖；行为规则未作重写。它们是后续统一验证的参考实现，不进入游戏发布，也不代表新Rust路径已经通过测试。

rail中的五个Node别名仅支持历史低层参考测试；现代与兼容运行的验收应调用新的RuntimeOwner/API，并与这些参考结果比较。源码AST清单及相应测试入口将在统一构建/验收时更新。
