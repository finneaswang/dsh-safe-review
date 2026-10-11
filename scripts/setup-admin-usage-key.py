#!/usr/bin/env python3
"""Local hidden-input helper. Never sends a key over the network or writes global configuration."""
import getpass
import os
from pathlib import Path
import re
import stat
import tempfile


def main():
    target = Path.home() / '.dsh' / 'safe-review' / 'admin-usage.key'
    print('设置 Safe Review 独立用量查询 Admin Key。输入不会显示，也不会进入聊天。')
    print('本密钥仅由独立查询进程访问 OpenAI 用量和费用接口；不会交给审核模型。取消可按 Ctrl+C。')
    print('仅保存到：' + str(target) + '（仅当前用户可读写）')
    key = getpass.getpass('粘贴 API Key，然后回车：').strip()
    if not re.fullmatch(r'sk-(?:admin|svcacct-admin)-[A-Za-z0-9_-]{16,512}', key):
        raise ValueError('密钥格式不符；没有保存。')
    for parent in reversed(target.parent.parents):
        if parent.is_symlink():
            raise ValueError('目录含符号链接；没有保存。')
    target.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    if target.parent.is_symlink() or target.parent.resolve() != target.parent:
        raise ValueError('保存目录不安全；没有保存。')
    info = target.parent.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('保存目录必须属于当前用户且权限为 700；没有保存。')
    if target.exists() or target.is_symlink():
        raise ValueError('已有密钥文件；本助手不会覆盖，轮换前请先保留旧文件并停止审核任务。')
    fd, temp_name = tempfile.mkstemp(prefix='.admin-usage-key-', dir=target.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as file:
            os.fchmod(file.fileno(), 0o600)
            file.write(key + '\n')
            file.flush()
            os.fsync(file.fileno())
        # Exclusive link refuses a concurrently created destination.
        os.link(temp_name, target, follow_symlinks=False)
    finally:
        os.unlink(temp_name)
    print('已保存。密钥内容不会显示。请重新打开 DSH 并查看 /safe-review 状态。')


if __name__ == '__main__':
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print('\n已取消。')
    except Exception:
        print('未能保存密钥。请确认目录权限、现有文件和Admin 密钥格式。密钥内容未输出。')
    input('按回车关闭窗口。')
