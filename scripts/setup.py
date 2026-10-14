#!/usr/bin/env python3
"""可选的源码开发辅助：生成私有 .env；部署包不需要本脚本。"""
import argparse
import json
import os
from pathlib import Path
import secrets
import stat
import sys


class SetupError(Exception):
    pass


def checked_path(path):
    path = Path(path).absolute()
    if '..' in path.parts or path.resolve(strict=False) != path or path.is_symlink():
        raise SetupError('拒绝符号链接或非规范路径。')
    return path


def initialize(root):
    root = checked_path(root)
    package = checked_path(root / 'package.json')
    try:
        if json.loads(package.read_text()).get('name') != 'agent-memory-stack':
            raise SetupError('项目名称不匹配。')
    except (ValueError, AttributeError):
        raise SetupError('项目配置无效。') from None
    env = checked_path(root / '.env')
    if env.exists():
        if not env.is_file():
            raise SetupError('.env 必须为普通文件。')
        print('保留已有 .env；不会读取或转换旧配置。')
        return 0
    template = checked_path(root / '.env.example').read_text(encoding='utf-8')
    placeholder = 'REPLACE_WITH_64_HEX_CHARACTERS'
    if template.count(placeholder) != 1:
        raise SetupError('环境模板缺少唯一主密钥占位符。')
    content = template.replace(placeholder, secrets.token_hex(32))
    fd = os.open(env, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        os.fchmod(stream.fileno(), stat.S_IRUSR | stat.S_IWUSR)
        stream.write(content)
    print('已生成0600 .env。Docker volumes由Compose创建，无需准备宿主目录。')
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).absolute().parent.parent)
    args = parser.parse_args(argv)
    try:
        return initialize(args.root)
    except (OSError, ValueError, SetupError):
        print('初始化失败：请检查项目、模板与文件权限；未输出配置内容。', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
