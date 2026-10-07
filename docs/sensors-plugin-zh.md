# Sensors 插件

Dashboard 侧边栏的 **Sensors** 页面展示当前项目的静态检测结果。它使用 Comet 的插件页面机制，读取与 `sensors show` 相同的状态文件，展示检查状态、评分、指标、问题位置和快照对比。

## 使用

先按照 [sensors-cli 的说明](https://github.com/HelloGGX/sensors-cli) 安装并配置 Sensors。在项目的 `.sensors/` 目录中放置 `*.sensors.yaml`，然后从项目目录运行：

```bash
sensors start .
sensors show .
comet dashboard .
```

在 Dashboard 中选择对应项目，点击侧边栏的 **Sensors**。点击 **刷新 Sensors** 可读取最新结果，页面也随 Dashboard 的自动刷新更新。

插件随 Comet 注册，不需要另装 npm 插件。Sensors CLI 和检查工具仍需按项目需要自行安装。打开页面、刷新、停用或卸载 Comet 插件，都不会执行配置中的检查命令，也不会启动或停止 Sensors 服务。服务已停止时，页面仍可展示最后保存的结果；更新时间表示结果写入时间，不代表服务正在运行。

## 数据与生命周期

`.sensors/example.sensors.yaml` 对应 `.sensors/example.state.json`。页面支持多个配置来源；尚未生成结果的检查、已停用的检查和按需检查也会根据配置显示。配置被移除但状态文件仍存在时，保留展示已有结果。

问题和报告以文本渲染。单个来源的数据损坏时，页面显示读取错误，其他来源仍可查看。为限制单次读取量，最多读取 32 个来源，配置文件上限为 1 MiB，状态文件上限为 8 MiB；超限会显示提示。插件不读取无限增长的 `history.jsonl`，评分变化来自状态文件中的 `snapshot`。

在 Sensors 页点击 **停用插件**，只暂停当前项目的页面数据读取。重新启用后可继续查看。点击 **卸载插件** 并确认后，入口消失，并保留项目的 `.sensors/` 配置和结果；Comet 更新不会自动恢复显式卸载的插件。

读取范围限于当前项目的 `.sensors/`，拒绝指向项目外部的目录链接和符号链接状态文件。旧版将 `formatted` 和 `score` 放在检查顶层的状态格式也可读取。
