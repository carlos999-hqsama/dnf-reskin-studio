"""formats — 格式专属层 (DNF 项目重写这一层, 这是唯一要换的)。

每个格式是一个普通模块, 暴露 6 个约定签名的函数 (见 CONTRACT.md):
detect / list_chars / load / write / copy_support_files / verify。
core 和 server.py 通过 `from formats import mugen as fmt` 直接用。
不搞插件框架 / 抽象基类 / 注册表 / 自动发现。
"""
