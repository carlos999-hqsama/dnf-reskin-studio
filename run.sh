#!/bin/bash
# 启动 DNF 补丁工具, 然后浏览器开 http://127.0.0.1:8773
cd "$(dirname "$0")"
exec .venv/bin/python server.py "$@"
